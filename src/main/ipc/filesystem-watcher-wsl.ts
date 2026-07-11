/** WSL file watching with native Linux events and a recursive scan fallback. */
import type { WebContents } from 'electron'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { queueWatcherEvents } from './filesystem-watcher-event-batch'
import { clearWslWatcherTimers, stopWslWatcherEngines } from './filesystem-watcher-wsl-disposal'
import { isPermanentWslNativeFailure } from './filesystem-watcher-wsl-failure-policy'
import { canonicalizeWslLinuxPath } from './filesystem-watcher-wsl-host-lifecycle'
import {
  createWslNativeEngine,
  createWslSnapshotEngine,
  type WslEngineContext,
  type WslWatchEngine
} from './filesystem-watcher-wsl-engine'
import { isWslDistroRunning } from './filesystem-watcher-wsl-runtime'
import { parseWslUncPath } from '../../shared/wsl-paths'

export type WatcherSubscription = {
  unsubscribe(): Promise<void>
}

type DebouncedBatch = {
  events: WatcherEvent[]
  overflowed: boolean
  timer: ReturnType<typeof setTimeout> | null
  firstEventAt: number
}

export type WatchedRoot = {
  subscription: WatcherSubscription
  listeners: Map<number, WebContents>
  batch: DebouncedBatch
}

export type WslWatcherDeps = {
  ignoreDirs: string[]
  scheduleBatchFlush: (rootKey: string, root: WatchedRoot) => void
  signal?: AbortSignal
}

const RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const
const STABLE_ENGINE_MS = 30_000,
  STOPPED_DISTRO_RECHECK_MS = 5_000
const NATIVE_REPROBE_DELAY_MS = 30_000
const UNSTABLE_NATIVE_EXIT_LIMIT = 3

type StartedEngine = { engine: WslWatchEngine; kind: 'native' | 'snapshot' }

function markOverflow(root: WatchedRoot): void {
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    root.batch.timer = null
  }
  root.batch.events = []
  root.batch.overflowed = true
}

export async function createWslWatcher(
  rootKey: string,
  worktreePath: string,
  deps: WslWatcherDeps
): Promise<WatchedRoot> {
  const wsl = parseWslUncPath(worktreePath)
  if (!wsl) {
    throw new Error(`Not a WSL path: ${worktreePath}`)
  }

  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: { events: [], overflowed: false, timer: null, firstEventAt: 0 }
  }
  let activeEngine: WslWatchEngine | null = null
  let activeEngineKind: StartedEngine['kind'] | null = null
  const startingEngines = new Set<WslWatchEngine>()
  let startGeneration = 0
  let disposed = false
  let nativeUnavailable = false
  let nativePermanentlyUnavailable = false
  let nativeRetryNeeded = false
  let unstableNativeExits = 0
  let restartAttempt = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null
  let nativeRetryTimer: ReturnType<typeof setTimeout> | null = null
  const maximumRestartDelay = RESTART_DELAYS_MS.at(-1) ?? 10_000

  const dispose = (): void => {
    if (!disposed) {
      disposed = true
      clearWslWatcherTimers([restartTimer, stabilityTimer, nativeRetryTimer])
      startGeneration += 1
      stopWslWatcherEngines(startingEngines, activeEngine)
      activeEngine = null
      activeEngineKind = null
    }
  }

  const beginEngineStart = (engine: WslWatchEngine): number => {
    const generation = ++startGeneration
    // Why: a newer recovery attempt supersedes every older pending attempt;
    // stopping all of them prevents late readiness from leaking a watcher.
    for (const pending of startingEngines) {
      pending.stop()
    }
    startingEngines.add(engine)
    return generation
  }
  const finishEngineStart = (engine: WslWatchEngine): void => {
    startingEngines.delete(engine)
  }
  const isCurrentStart = (generation: number): boolean =>
    !disposed && generation === startGeneration

  const context: WslEngineContext = {
    distro: wsl.distro,
    linuxPath: canonicalizeWslLinuxPath(wsl.linuxPath),
    worktreePath,
    ignoreDirs: deps.ignoreDirs,
    onEvents: (events) => {
      queueWatcherEvents(root.batch, events)
      deps.scheduleBatchFlush(rootKey, root)
    },
    onOverflow: () => {
      markOverflow(root)
      deps.scheduleBatchFlush(rootKey, root)
    }
  }

  const recordNativeFailure = (error: unknown): void => {
    nativeUnavailable = true
    if (isPermanentWslNativeFailure(error)) {
      nativePermanentlyUnavailable = true
      nativeRetryNeeded = false
    } else {
      nativeRetryNeeded = true
    }
  }

  const startEngine = async (): Promise<StartedEngine | null> => {
    if (disposed) {
      return null
    }
    if (!nativeUnavailable) {
      const native = createWslNativeEngine(context)
      const generation = beginEngineStart(native)
      try {
        await native.ready
        finishEngineStart(native)
        if (!isCurrentStart(generation)) {
          native.stop()
          return null
        }
        return { engine: native, kind: 'native' }
      } catch (error) {
        finishEngineStart(native)
        native.stop()
        if (!isCurrentStart(generation)) {
          return null
        }
        recordNativeFailure(error)
      }
    }
    if (disposed) {
      return null
    }
    const snapshot = createWslSnapshotEngine(context)
    const generation = beginEngineStart(snapshot)
    try {
      await snapshot.ready
    } catch (error) {
      finishEngineStart(snapshot)
      snapshot.stop()
      if (!isCurrentStart(generation)) {
        return null
      }
      // Why: without a live snapshot, transient native failures must be
      // retried by the bounded restart loop instead of pinning an unwatched root.
      if (nativeRetryNeeded && !nativePermanentlyUnavailable) {
        nativeUnavailable = false
      }
      throw error
    }
    finishEngineStart(snapshot)
    if (!isCurrentStart(generation)) {
      snapshot.stop()
      return null
    }
    return { engine: snapshot, kind: 'snapshot' }
  }

  let installEngine: () => Promise<void>
  let reprobeNative: () => Promise<void>
  const scheduleNativeReprobe = (): void => {
    if (disposed || nativePermanentlyUnavailable || !nativeRetryNeeded || nativeRetryTimer) {
      return
    }
    nativeRetryTimer = setTimeout(() => {
      nativeRetryTimer = null
      void reprobeNative()
    }, NATIVE_REPROBE_DELAY_MS)
  }
  const scheduleRestart = (delay: number): void => {
    restartTimer = setTimeout(() => {
      restartTimer = null
      void isWslDistroRunning(wsl.distro).then((running) => {
        if (disposed) {
          return
        }
        if (!running) {
          // Why: restarting a watcher through `wsl.exe -d` would undo an
          // intentional WSL shutdown; the running-distro query does not wake it.
          scheduleRestart(STOPPED_DISTRO_RECHECK_MS)
          return
        }
        void installEngine().catch(() => {
          if (!disposed) {
            scheduleRestart(maximumRestartDelay)
          }
        })
      })
    }, delay)
  }

  const activateEngine = (started: StartedEngine): void => {
    const { engine } = started
    if (stabilityTimer) {
      clearTimeout(stabilityTimer)
    }
    activeEngine = engine
    activeEngineKind = started.kind
    stabilityTimer = setTimeout(() => {
      restartAttempt = 0
      if (started.kind === 'native') {
        unstableNativeExits = 0
      }
    }, STABLE_ENGINE_MS)
    if (started.kind === 'snapshot') {
      scheduleNativeReprobe()
    }
    void engine.stopped.then((reason) => {
      if (disposed || activeEngine !== engine) {
        return
      }
      activeEngine = null
      activeEngineKind = null
      if (stabilityTimer) {
        clearTimeout(stabilityTimer)
      }
      if (started.kind === 'native' && reason !== 'topology') {
        unstableNativeExits += 1
        if (unstableNativeExits >= UNSTABLE_NATIVE_EXIT_LIMIT) {
          // Why: a host that repeatedly starts and dies is less reliable than
          // the scanner; circuit-break temporarily, then probe native again.
          nativeUnavailable = true
          nativeRetryNeeded = true
        }
      }
      markOverflow(root)
      deps.scheduleBatchFlush(rootKey, root)
      const delay =
        RESTART_DELAYS_MS.at(
          reason === 'topology' ? 0 : Math.min(restartAttempt, RESTART_DELAYS_MS.length - 1)
        ) ?? maximumRestartDelay
      if (reason !== 'topology') {
        restartAttempt += 1
      }
      // Why: WSL shutdowns and transient distro failures must not permanently
      // orphan an active renderer subscription.
      scheduleRestart(delay)
    })
  }

  reprobeNative = async (): Promise<void> => {
    const snapshot = activeEngineKind === 'snapshot' ? activeEngine : null
    if (disposed || !snapshot) {
      return
    }
    const native = createWslNativeEngine(context)
    const generation = beginEngineStart(native)
    try {
      await native.ready
    } catch (error) {
      finishEngineStart(native)
      native.stop()
      if (!isCurrentStart(generation)) {
        return
      }
      recordNativeFailure(error)
      scheduleNativeReprobe()
      return
    }
    finishEngineStart(native)
    if (!isCurrentStart(generation) || activeEngine !== snapshot) {
      native.stop()
      return
    }
    // Why: keep snapshots live until native is ready so recovery probes never
    // create an unwatched gap after a transient or unstable native failure.
    nativeUnavailable = false
    nativeRetryNeeded = false
    // Why: snapshot output and native readiness have no shared sequence token;
    // one conservative refresh closes the handoff race without duplicate paths.
    markOverflow(root)
    deps.scheduleBatchFlush(rootKey, root)
    activateEngine({ engine: native, kind: 'native' })
    snapshot.stop()
  }

  installEngine = async (): Promise<void> => {
    const started = await startEngine()
    if (!started) {
      return
    }
    activateEngine(started)
  }

  const onAbort = (): void => dispose()
  if (deps.signal?.aborted) {
    dispose()
    throw new Error('WSL watcher startup was cancelled')
  }
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await installEngine()
    if (disposed) {
      throw new Error('WSL watcher startup was cancelled')
    }
    root.subscription = { unsubscribe: async () => dispose() }
    return root
  } finally {
    deps.signal?.removeEventListener('abort', onAbort)
  }
}
