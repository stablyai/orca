import { normalizeAgentStatusPayload } from '../../shared/agent-status/contracts/agent-status-types'
import { agentWorksBehindQuestion } from '../../shared/agent-status/lifecycle/agent-works-behind-question'
import type { WslHostAwakeStatus } from './agent-awake-service'

type HostConnection = { environmentId: string; state: string }
type HostStream = { close: () => void }

export type WslHostAgentAwakeDeps = {
  listHosts: () => readonly HostConnection[]
  onHostsChanged: (listener: () => void) => () => void
  /** Opens the host's session-tabs inventory stream; `onEnd` fires once when it can carry no more.
   *  'unsupported' means this host must not be watched (no longer a WSL host, or disconnected by hand).
   *  A rejection is a failure to retry, never a verdict on the host. */
  openStream: (
    environmentId: string,
    handlers: { onFrame: (frame: unknown) => void; onEnd: () => void }
  ) => Promise<HostStream | 'unsupported'>
  report: (environmentId: string, statuses: WslHostAwakeStatus[]) => void
  now: () => number
}

/** One working pane. `hostObservedAt` only tells a new observation from a repeat; `receivedAt` is
 *  this machine's first receipt of it, or null for a row already working before this app saw the host. */
type PaneReceipt = { hostObservedAt: number; receivedAt: number | null }

type HostWatch = {
  stream: HostStream | null
  /** Working panes per host worktree, as the current stream last described them. */
  worktrees: Map<string, Map<string, PaneReceipt>>
  retryTimer: ReturnType<typeof setTimeout> | null
  retryAttempt: number
}

// Why not sooner: right after orcad exits the host may still read ready until its supervisor verifies.
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000]

/** Counts agents working on this machine's WSL hosts from the host's own session stream, so a
 *  hidden or tray-parked window never hides them from keep-awake. */
export class WslHostAgentAwake {
  private readonly watches = new Map<string, HostWatch>()
  /** Per host, outliving its streams and connections; dropped only when the host is removed. */
  private readonly receiptsByEnvironment = new Map<string, Map<string, PaneReceipt>>()
  private readonly reported = new Map<string, string>()
  private readonly stopListening: () => void
  private disposed = false

  constructor(private readonly deps: WslHostAgentAwakeDeps) {
    this.stopListening = deps.onHostsChanged(() => this.reconcile())
    this.reconcile()
  }

  dispose(): void {
    this.disposed = true
    this.stopListening()
    for (const environmentId of this.watches.keys()) {
      this.stop(environmentId)
    }
  }

  private reconcile(): void {
    if (this.disposed) {
      return
    }
    const hosts = this.deps.listHosts()
    const known = new Set(hosts.map((host) => host.environmentId))
    for (const environmentId of this.receiptsByEnvironment.keys()) {
      if (!known.has(environmentId)) {
        this.receiptsByEnvironment.delete(environmentId)
      }
    }
    const ready = new Set(
      hosts.filter((host) => host.state === 'ready').map((host) => host.environmentId)
    )
    for (const environmentId of this.watches.keys()) {
      if (!ready.has(environmentId)) {
        this.stop(environmentId)
      }
    }
    for (const environmentId of ready) {
      if (!this.watches.has(environmentId)) {
        const watch: HostWatch = {
          stream: null,
          worktrees: new Map(),
          retryTimer: null,
          retryAttempt: 0
        }
        this.watches.set(environmentId, watch)
        this.open(environmentId, watch)
      }
    }
  }

  private open(environmentId: string, watch: HostWatch): void {
    let ended = false
    const isCurrent = (): boolean => !ended && this.watches.get(environmentId) === watch
    const end = (): void => {
      if (!isCurrent()) {
        return
      }
      ended = true
      watch.stream?.close()
      watch.stream = null
      // Why: a dropped stream proves nothing is known any more; stop counting now, not at expiry.
      watch.worktrees.clear()
      this.publish(environmentId, watch)
      this.scheduleRetry(environmentId, watch)
    }
    this.deps
      .openStream(environmentId, {
        onFrame: (frame) => {
          if (!isCurrent()) {
            return
          }
          if (this.applyFrame(environmentId, watch, frame)) {
            watch.retryAttempt = 0
            this.publish(environmentId, watch)
          } else if (isEndFrame(frame)) {
            end()
          }
        },
        onEnd: end
      })
      .then(
        (stream) => {
          if (stream === 'unsupported') {
            // Stays unwatched until the host reconnects, possibly as a newer server.
            ended = true
          } else if (isCurrent()) {
            watch.stream = stream
          } else {
            stream.close()
          }
        },
        () => end()
      )
  }

  private scheduleRetry(environmentId: string, watch: HostWatch): void {
    const delay = RETRY_DELAYS_MS[Math.min(watch.retryAttempt, RETRY_DELAYS_MS.length - 1)]
    watch.retryAttempt += 1
    watch.retryTimer = setTimeout(() => {
      watch.retryTimer = null
      if (this.watches.get(environmentId) === watch) {
        this.open(environmentId, watch)
      }
    }, delay)
    watch.retryTimer.unref?.()
  }

  private stop(environmentId: string): void {
    const watch = this.watches.get(environmentId)
    if (!watch) {
      return
    }
    this.watches.delete(environmentId)
    if (watch.retryTimer) {
      clearTimeout(watch.retryTimer)
    }
    watch.stream?.close()
    this.reported.delete(environmentId)
    this.deps.report(environmentId, [])
  }

  /** Returns whether the frame described host worktrees. */
  private applyFrame(environmentId: string, watch: HostWatch, frame: unknown): boolean {
    if (!isRecord(frame)) {
      return false
    }
    const receipts = this.receiptsByEnvironment.get(environmentId)
    if (frame.type === 'snapshots' && Array.isArray(frame.snapshots)) {
      // Why: rows already working when this app first sees the host are hydrated, not observed.
      const hydrating = receipts === undefined
      watch.worktrees.clear()
      for (const snapshot of frame.snapshots) {
        this.applySnapshot(watch, receipts, snapshot, hydrating)
      }
    } else if (frame.type === 'updated' || frame.type === 'snapshot') {
      this.applySnapshot(watch, receipts, frame, false)
    } else {
      return false
    }
    // The stream just described every worktree it knows: keep receipts only for panes still working.
    const current = new Map<string, PaneReceipt>()
    for (const panes of watch.worktrees.values()) {
      for (const [paneKey, receipt] of panes) {
        current.set(paneKey, receipt)
      }
    }
    this.receiptsByEnvironment.set(environmentId, current)
    return true
  }

  private applySnapshot(
    watch: HostWatch,
    receipts: ReadonlyMap<string, PaneReceipt> | undefined,
    snapshot: unknown,
    hydrating: boolean
  ): void {
    if (!isRecord(snapshot) || typeof snapshot.worktree !== 'string') {
      return
    }
    if (snapshot.removed === true || !Array.isArray(snapshot.tabs)) {
      watch.worktrees.delete(snapshot.worktree)
      return
    }
    const panes = new Map<string, PaneReceipt>()
    for (const tab of snapshot.tabs) {
      const hostObservedAt = workingHostObservedAt(tab)
      if (hostObservedAt === null || !isRecord(tab) || typeof tab.id !== 'string') {
        continue
      }
      const paneKey = `${snapshot.worktree}\0${tab.id}`
      const previous = receipts?.get(paneKey)
      // Why: a repeated observation keeps its first receipt, so resent frames never extend the lease.
      const receipt =
        previous?.hostObservedAt === hostObservedAt
          ? previous
          : { hostObservedAt, receivedAt: hydrating ? null : this.deps.now() }
      panes.set(paneKey, receipt)
    }
    watch.worktrees.set(snapshot.worktree, panes)
  }

  private publish(environmentId: string, watch: HostWatch): void {
    const statuses: WslHostAwakeStatus[] = []
    for (const panes of watch.worktrees.values()) {
      for (const [paneKey, receipt] of panes) {
        if (receipt.receivedAt !== null) {
          statuses.push({ paneKey, receivedAt: receipt.receivedAt })
        }
      }
    }
    const reported = statuses.map((status) => `${status.paneKey}@${status.receivedAt}`).join('\n')
    if (reported === (this.reported.get(environmentId) ?? '')) {
      return
    }
    this.reported.set(environmentId, reported)
    this.deps.report(environmentId, statuses)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isEndFrame(frame: unknown): boolean {
  return isRecord(frame) && frame.type === 'end'
}

/** The host's evidence clock for a live working terminal agent, or null when it should not count. */
function workingHostObservedAt(tab: unknown): number | null {
  if (!isRecord(tab) || tab.type !== 'terminal' || !isRecord(tab.agentStatus)) {
    return null
  }
  const status = tab.agentStatus
  // Restored and sleeping rows keep identity only, matching what local keep-awake ignores.
  if (status.restoredUnconfirmed === true || status.paneSleep) {
    return null
  }
  if (status.state !== 'working') {
    const row = status.state === 'waiting' ? normalizeAgentStatusPayload(status) : null
    if (!row || !agentWorksBehindQuestion(row)) {
      return null
    }
  }
  const observedAt =
    typeof status.evidenceObservedAt === 'number' ? status.evidenceObservedAt : status.updatedAt
  return typeof observedAt === 'number' && Number.isFinite(observedAt) ? observedAt : null
}
