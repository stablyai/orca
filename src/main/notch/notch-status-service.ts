import type { NotchCompletionRead } from '../../shared/notch/notch-snapshot'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status/contracts/agent-status-freshness'
import {
  EMPTY_NOTCH_SUMMARY,
  buildNotchSummary,
  type NotchStatusSummary,
  type NotchStatusObservation
} from '../../shared/notch/notch-status-summary'

export type NotchStatusSource = {
  getStatusSnapshot(): readonly NotchStatusObservation[]
  subscribeStatusRowMutations(listener: () => void): () => void
}

export type NotchStatusServiceOptions = {
  source: NotchStatusSource
  acknowledgedCompletions?: Readonly<Record<string, string>>
  onAcknowledgedCompletionsChanged?: (completions: Readonly<Record<string, string>>) => void
  /** Coalesces bursts; a hook storm across worktrees must not repaint per event. */
  scheduleFlush?: (flush: () => void) => () => void
}

const MAX_ACKNOWLEDGEMENTS = 10_000
const DEFAULT_FLUSH_DELAY_MS = 80

function defaultScheduleFlush(flush: () => void): () => void {
  const timer = setTimeout(flush, DEFAULT_FLUSH_DELAY_MS)
  return () => clearTimeout(timer)
}

export class NotchStatusService {
  private readonly source: NotchStatusSource
  private readonly scheduleFlush: (flush: () => void) => () => void
  private freshnessExpiry: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(summary: NotchStatusSummary) => void>()
  private readonly unsubscribes: (() => void)[] = []
  private readonly acknowledgedCompletions: Record<string, string>
  private readonly onAcknowledgedCompletionsChanged: NotchStatusServiceOptions['onAcknowledgedCompletionsChanged']
  private viewedPaneKeys = new Set<string>()
  private summary: NotchStatusSummary = EMPTY_NOTCH_SUMMARY
  private cancelPendingFlush: (() => void) | null = null
  private flushPending = false
  private started = false

  constructor(options: NotchStatusServiceOptions) {
    this.acknowledgedCompletions = Object.fromEntries(
      Object.entries(options.acknowledgedCompletions ?? {})
        .filter(
          ([key, identity]) =>
            key.length > 0 &&
            key.length <= 512 &&
            ((key.startsWith('runtime:') && key.includes('|')) ||
              (typeof identity === 'string' && identity.startsWith('local:'))) &&
            typeof identity === 'string' &&
            identity.length > 0 &&
            identity.length <= 1024
        )
        .slice(-MAX_ACKNOWLEDGEMENTS)
    )
    this.onAcknowledgedCompletionsChanged = options.onAcknowledgedCompletionsChanged
    this.source = options.source
    this.scheduleFlush = options.scheduleFlush ?? defaultScheduleFlush
  }

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    this.unsubscribes.push(this.source.subscribeStatusRowMutations(() => this.requestRecompute()))
    this.recompute()
  }

  stop(): void {
    this.cancelPendingFlush?.()
    this.cancelPendingFlush = null
    this.flushPending = false
    if (this.freshnessExpiry) {
      clearTimeout(this.freshnessExpiry)
    }
    this.freshnessExpiry = null
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe()
    }
    this.listeners.clear()
    this.viewedPaneKeys.clear()
    this.started = false
  }

  getSummary(): NotchStatusSummary {
    return this.summary
  }

  subscribe(listener: (summary: NotchStatusSummary) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setViewedPanes(paneKeys: readonly string[]): void {
    const next = new Set(paneKeys)
    if (
      next.size === this.viewedPaneKeys.size &&
      [...next].every((key) => this.viewedPaneKeys.has(key))
    ) {
      return
    }
    this.viewedPaneKeys = next
    if (this.started) {
      this.recompute()
    }
  }

  acknowledgePanes(reads: readonly NotchCompletionRead[]): void {
    let completionsChanged = false
    const snapshot = this.source.getStatusSnapshot()
    for (const read of reads) {
      const paneKey = read.paneKey
      const row = snapshot.find((entry) => entry.paneKey === paneKey)
      if (
        row?.state !== 'done' ||
        (row.hostStateStartedAt ?? row.stateStartedAt) !== read.stateStartedAt ||
        row.turnStartedAt !== read.turnStartedAt ||
        row.stateStartedAt > read.observedAt
      ) {
        continue
      }
      const identity = completionIdentity(row)
      if (this.acknowledgedCompletions[paneKey] !== identity) {
        delete this.acknowledgedCompletions[paneKey]
        this.acknowledgedCompletions[paneKey] = identity
        completionsChanged = true
      }
    }
    if (completionsChanged) {
      const keys = Object.keys(this.acknowledgedCompletions)
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ACKNOWLEDGEMENTS))) {
        delete this.acknowledgedCompletions[key]
      }
      try {
        this.onAcknowledgedCompletionsChanged?.({ ...this.acknowledgedCompletions })
      } catch (error) {
        console.warn('[notch] Could not persist read completions:', error)
      }
    }
    if (completionsChanged && this.started) {
      this.recompute()
    }
  }

  private requestRecompute(): void {
    if (this.flushPending) {
      return
    }
    this.flushPending = true
    this.cancelPendingFlush = this.scheduleFlush(() => {
      this.flushPending = false
      this.cancelPendingFlush = null
      this.recompute()
    })
  }

  private recompute(): void {
    const snapshot = this.source.getStatusSnapshot()
    this.scheduleFreshnessExpiry(snapshot)
    const next = buildNotchSummary({
      snapshot: snapshot.map((row) => ({ ...row, completionIdentity: completionIdentity(row) })),
      acknowledgedAtByPaneKey: {},
      acknowledgedCompletions: this.acknowledgedCompletions,
      viewedPaneKeys: this.viewedPaneKeys
    })
    if (summariesEqual(this.summary, next)) {
      return
    }
    this.summary = next
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch (err) {
        console.error('[notch] summary listener threw', err)
      }
    }
  }

  private scheduleFreshnessExpiry(snapshot: readonly NotchStatusObservation[]): void {
    if (this.freshnessExpiry) {
      clearTimeout(this.freshnessExpiry)
    }
    this.freshnessExpiry = null
    const now = Date.now()
    let next = Infinity
    for (const entry of snapshot) {
      if (
        entry.state === 'done' ||
        entry.providerSessionOnly ||
        entry.restoredUnconfirmed ||
        entry.structuredHost === 'owned' ||
        entry.structuredHostOwned
      ) {
        continue
      }
      const observedAt =
        entry.mirroredEvidenceReceivedAt ?? entry.evidenceObservedAt ?? entry.receivedAt
      const expiresAt = observedAt + AGENT_STATUS_STALE_AFTER_MS + 1
      if (expiresAt > now) {
        next = Math.min(next, expiresAt)
      }
    }
    if (Number.isFinite(next)) {
      this.freshnessExpiry = setTimeout(
        () => {
          this.freshnessExpiry = null
          if (this.started) {
            this.recompute()
          }
        },
        Math.min(2_147_483_647, Math.max(1, next - now))
      )
      this.freshnessExpiry.unref?.()
    }
  }
}

function completionIdentity(row: NotchStatusObservation): string {
  return (
    row.completionIdentity ??
    `local:${JSON.stringify([row.stateStartedAt, row.turnStartedAt ?? null])}`
  )
}

function summariesEqual(a: NotchStatusSummary, b: NotchStatusSummary): boolean {
  if (
    a.counts.working !== b.counts.working ||
    a.counts.attention !== b.counts.attention ||
    a.counts.done !== b.counts.done ||
    a.sessions.length !== b.sessions.length
  ) {
    return false
  }
  return a.sessions.every((session, index) => {
    const other = b.sessions[index]
    return (
      session.paneKey === other.paneKey &&
      session.executionHostId === other.executionHostId &&
      session.sessionId === other.sessionId &&
      session.title === other.title &&
      session.leafId === other.leafId &&
      session.lane === other.lane &&
      session.state === other.state &&
      session.stateStartedAt === other.stateStartedAt &&
      session.worktreeId === other.worktreeId &&
      session.tabId === other.tabId &&
      session.agentType === other.agentType &&
      session.connectionId === other.connectionId
    )
  })
}
