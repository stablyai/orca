import {
  applyNativeEventsToSafetySnapshot,
  reconcileWatcherSafetySnapshots,
  scanWatcherSafetySnapshot,
  watcherSafetyDelay,
  type SafetyScanOptions,
  type SafetyScanResult,
  type SafetySnapshot,
  type SafetyWatcherEvent
} from './wsl-watcher-host-safety'

export type WatcherSafetyScanner = (
  root: string,
  ignoreDirs: ReadonlySet<string>,
  options?: SafetyScanOptions
) => Promise<SafetyScanResult>

export type WatcherReconciliationState = {
  id: number
  dir: string
  ignoreDirs: Set<string>
  safetySnapshot: SafetySnapshot
  reconcileTimer: ReturnType<typeof setTimeout> | null
  interrupted: boolean
  abortController: AbortController
  scanEvents: SafetyWatcherEvent[] | null
  scanEventsOverflowed: boolean
  nativeEventCount: number
  idleRounds: number
  operationTail: Promise<void>
  pendingNativeEvents: number
  resourceBudget: WatcherHostResourceBudget
  reservedSnapshotEntries: number
  reservedJournalEvents: number
  reservedPendingEvents: number
}

type ResourceKind = 'journalEvents' | 'pendingEvents' | 'snapshotEntries'
export type WatcherHostResourceLimits = Partial<Record<ResourceKind, number>>
export type WatcherHostResourceBudget = {
  reserve(kind: ResourceKind, count: number): boolean
  release(kind: ResourceKind, count: number): void
}

type ReconciliationDeps<State extends WatcherReconciliationState> = {
  isCurrent: (state: State) => boolean
  interrupt: (state: State, message: string, reason?: 'topology') => void
  emitEvents: (state: State, events: SafetyWatcherEvent[]) => void
  scan?: WatcherSafetyScanner
}

const MAX_SCAN_JOURNAL_EVENTS = 10_000
const MAX_PENDING_NATIVE_EVENTS = 10_000
const DEFAULT_RESOURCE_LIMITS: Record<ResourceKind, number> = {
  snapshotEntries: 500_000,
  journalEvents: 50_000,
  pendingEvents: 50_000
}

export function createWatcherHostResourceBudget(
  overrides: WatcherHostResourceLimits = {}
): WatcherHostResourceBudget {
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...overrides }
  const usage: Record<ResourceKind, number> = {
    snapshotEntries: 0,
    journalEvents: 0,
    pendingEvents: 0
  }
  return {
    reserve: (kind, count) => {
      if (count < 0 || usage[kind] + count > limits[kind]) {
        return false
      }
      usage[kind] += count
      return true
    },
    release: (kind, count) => {
      usage[kind] = Math.max(0, usage[kind] - count)
    }
  }
}

export function replaceWatcherSafetySnapshot(
  state: WatcherReconciliationState,
  snapshot: SafetySnapshot
): boolean {
  const difference = snapshot.size - state.reservedSnapshotEntries
  if (difference > 0 && !state.resourceBudget.reserve('snapshotEntries', difference)) {
    return false
  }
  if (difference < 0) {
    state.resourceBudget.release('snapshotEntries', -difference)
  }
  state.reservedSnapshotEntries = snapshot.size
  state.safetySnapshot = snapshot
  return true
}

export function releaseWatcherReconciliationResources(state: WatcherReconciliationState): void {
  state.resourceBudget.release('snapshotEntries', state.reservedSnapshotEntries)
  state.resourceBudget.release('journalEvents', state.reservedJournalEvents)
  state.resourceBudget.release('pendingEvents', state.reservedPendingEvents)
  state.reservedSnapshotEntries = 0
  state.reservedJournalEvents = 0
  state.reservedPendingEvents = 0
  state.safetySnapshot = new Map()
  state.scanEvents = null
}

export function createWatcherReconciliation<State extends WatcherReconciliationState>(
  deps: ReconciliationDeps<State>
) {
  const scan = deps.scan ?? scanWatcherSafetySnapshot

  const serialize = <Result>(state: State, operation: () => Promise<Result>): Promise<Result> => {
    const result = state.operationTail.then(operation, operation)
    state.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const checkpoint = async (state: State): Promise<boolean> => {
    if (state.interrupted || !deps.isCurrent(state)) {
      return false
    }
    state.scanEvents ??= []
    let result: SafetyScanResult
    try {
      result = await scan(state.dir, state.ignoreDirs, {
        signal: state.abortController.signal
      })
    } catch {
      state.scanEvents = null
      deps.interrupt(state, 'recursive watch reconciliation io-error')
      return false
    }
    const concurrentEvents = state.scanEvents
    state.scanEvents = null
    const journalReservation = state.reservedJournalEvents
    state.reservedJournalEvents = 0
    if (state.interrupted || !deps.isCurrent(state) || result.kind === 'cancelled') {
      state.resourceBudget.release('journalEvents', journalReservation)
      return false
    }
    if (state.scanEventsOverflowed) {
      state.resourceBudget.release('journalEvents', journalReservation)
      deps.interrupt(state, 'recursive watch reconciliation journal-limit')
      return false
    }
    if (result.kind === 'resource-limit') {
      state.resourceBudget.release('journalEvents', journalReservation)
      state.scanEventsOverflowed = false
      return true
    }
    if (result.kind !== 'complete') {
      state.resourceBudget.release('journalEvents', journalReservation)
      deps.interrupt(state, `recursive watch reconciliation ${result.kind}`)
      return false
    }
    state.scanEventsOverflowed = false
    return serialize(state, async () => {
      try {
        if (state.interrupted || !deps.isCurrent(state)) {
          return false
        }
        const applied = await applyNativeEventsToSafetySnapshot(
          state.dir,
          result.snapshot,
          concurrentEvents ?? [],
          { signal: state.abortController.signal }
        )
        if (applied === 'cancelled') {
          return false
        }
        if (applied === 'topology') {
          deps.interrupt(state, 'recursive watch reconciliation required', 'topology')
          return false
        }
        const difference = reconcileWatcherSafetySnapshots(state.safetySnapshot, result.snapshot)
        if (difference.topologyChanged || !replaceWatcherSafetySnapshot(state, result.snapshot)) {
          deps.interrupt(state, 'recursive watch reconciliation required', 'topology')
          return false
        }
        if (difference.events.length > 0) {
          deps.emitEvents(state, difference.events)
        }
        return true
      } finally {
        state.resourceBudget.release('journalEvents', journalReservation)
      }
    })
  }

  let schedule: (state: State) => void
  const arm = (state: State, delay: number): void => {
    if (state.interrupted || !deps.isCurrent(state)) {
      return
    }
    state.reconcileTimer = setTimeout(() => {
      state.reconcileTimer = null
      void checkpoint(state).then((complete) => {
        if (complete) {
          schedule(state)
        }
      })
    }, delay)
    state.reconcileTimer.unref?.()
  }

  schedule = (state: State): void => {
    const eventCount = state.nativeEventCount
    state.nativeEventCount = 0
    state.idleRounds = eventCount === 0 ? state.idleRounds + 1 : 0
    arm(state, watcherSafetyDelay(state.dir, eventCount, state.idleRounds))
  }

  const recordNativeEvents = (state: State, events: SafetyWatcherEvent[]): boolean => {
    if (state.interrupted || !deps.isCurrent(state)) {
      return false
    }
    if (
      state.pendingNativeEvents + events.length > MAX_PENDING_NATIVE_EVENTS ||
      !state.resourceBudget.reserve('pendingEvents', events.length)
    ) {
      deps.interrupt(state, 'recursive watch native event queue-limit', 'topology')
      return false
    }
    state.reservedPendingEvents += events.length
    if (state.scanEvents) {
      if (
        state.scanEvents.length + events.length > MAX_SCAN_JOURNAL_EVENTS ||
        !state.resourceBudget.reserve('journalEvents', events.length)
      ) {
        state.resourceBudget.release('pendingEvents', events.length)
        state.reservedPendingEvents -= events.length
        state.scanEvents = []
        state.scanEventsOverflowed = true
        deps.interrupt(state, 'recursive watch reconciliation journal-limit', 'topology')
        return false
      } else {
        state.reservedJournalEvents += events.length
        state.scanEvents.push(...events)
      }
    }
    const previousCount = state.nativeEventCount
    state.nativeEventCount += events.length
    if (previousCount < 1_000 && state.nativeEventCount >= 1_000 && state.reconcileTimer) {
      clearTimeout(state.reconcileTimer)
      state.reconcileTimer = null
      arm(state, watcherSafetyDelay(state.dir, state.nativeEventCount, 0))
    }
    state.pendingNativeEvents += events.length
    void serialize(state, async () => {
      try {
        if (state.interrupted || !deps.isCurrent(state)) {
          return
        }
        const applied = await applyNativeEventsToSafetySnapshot(
          state.dir,
          state.safetySnapshot,
          events,
          { signal: state.abortController.signal }
        )
        if (applied === 'topology') {
          deps.interrupt(state, 'recursive watch topology changed', 'topology')
        } else if (applied === 'applied' && !state.interrupted && deps.isCurrent(state)) {
          deps.emitEvents(state, events)
        }
      } catch {
        deps.interrupt(state, 'recursive watch topology uncertain', 'topology')
      } finally {
        state.pendingNativeEvents -= events.length
        const released = Math.min(events.length, state.reservedPendingEvents)
        state.reservedPendingEvents -= released
        state.resourceBudget.release('pendingEvents', released)
      }
    })
    return true
  }

  return { checkpoint, recordNativeEvents, schedule }
}
