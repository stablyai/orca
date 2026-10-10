// Periodic backstop for PTY processes nobody owns any more.
//
// Orca's descendant handling is entirely event driven: it runs when a session is torn down. That
// covers every case where a teardown actually happens. It covers none of the cases where one
// does not — a daemon killed by the updater, a crash, a force quit, a machine that slept through
// the sweep's grace window. Those leave processes whose parent is now pid 1 and whose session
// map entry no longer exists anywhere, and nothing ever looks for them again.
//
// This reconciler is the thing that looks. Once every few minutes it reads one process table and
// compares it against the durable ownership records the daemon keeps while it is live, the only
// correlation that still works after the root is gone.

import {
  readFreshProcessTable,
  terminateDescendantSnapshot,
  type ProcessTableCapture,
  type ProcessTableReader
} from '../pty-descendant-termination'
import {
  planOrphanReap,
  type LiveSessionIdentity,
  type OrphanRecordDropReason,
  type OrphanReapPlan,
  type OrphanReapTarget
} from './daemon-orphan-reap-plan'
import { adoptLegacyPtyOwnershipStores } from './pty-ownership-legacy-stores'
import type { PtyOwnershipRecordStore } from './pty-ownership-record-store'

/** Long enough that a whole-host `ps` is noise (0.12s on a 1,900-process host), short enough that
 *  a leak is measured in minutes rather than days. */
export const ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000

/** The first tick only ever observes — reaping needs a second one — so it runs early rather than a
 *  full interval in, which is what keeps a restart's leftovers to roughly one interval. */
export const ORPHAN_RECONCILE_INITIAL_DELAY_MS = 30 * 1000

/** A record younger than this is never reaped. A create publishes its session before its record,
 *  but the two are not one write, and a tick must never land inside that gap and win. */
export const ORPHAN_SPAWN_GRACE_MS = 60 * 1000

/** A day of ticks that never managed to identify a record's processes means they cannot be found.
 *  Holding the record past that buys nothing and accumulates pid-reuse exposure. */
export const ORPHAN_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** `lstart` is second-resolution and a daemon's self-reported start time is taken inside Node, a
 *  bootstrap after the kernel's. */
const DAEMON_START_TOLERANCE_MS = 5_000

/** Generous next to the 0.12s a 1,900-process capture measures, because nothing waits on this:
 *  the daemon is idle between ticks and a slow host should still get reconciled. Deliberately
 *  spent on a private scan rather than the coalescing reader teardown shares, so this deadline can
 *  never become a teardown's. */
const PROCESS_TABLE_TIMEOUT_MS = 15_000

/** Log payloads ride the daemon's rotated NDJSON log; a runaway fork bomb must not be able to
 *  write megabytes into one line. The count is always exact even when the list is clipped. */
const MAX_LOGGED_PIDS = 16

export type DaemonOrphanReconcilerOptions = {
  store: PtyOwnershipRecordStore
  /** Sessions the daemon currently has a live root for. */
  listLiveSessions: () => LiveSessionIdentity[]
  log: (event: string, details?: Record<string, unknown>) => void
  platform?: NodeJS.Platform
  selfPid?: number
  /** When this daemon started. A record it wrote itself is never reap authority: the session
   *  ended under a daemon that ran its teardown. */
  daemonStartedAtMs: number | null
  /** Ownership files other protocol versions left behind, adopted once their daemons are gone. */
  listLegacyStores?: () => string[]
  now?: () => number
  intervalMs?: number
  initialDelayMs?: number
  readTable?: ProcessTableReader
  /** Escalation reader handed to the shared descendant terminator; production uses its default. */
  escalationReadTable?: ProcessTableReader
  /** How long SIGTERM'd members get before an identity-checked SIGKILL. Production uses the same
   *  grace teardown does; tests shorten it. */
  escalationGraceMs?: number
  terminateMembers?: (target: OrphanReapTarget, capturedAtMs: number) => void
}

function cap(pids: readonly number[]): number[] {
  return pids.length > MAX_LOGGED_PIDS ? pids.slice(0, MAX_LOGGED_PIDS) : [...pids]
}

/**
 * Owns the timer, the capture and the signals. The decision itself lives in
 * `daemon-orphan-reap-plan.ts` and is pure, so what this class contributes is only the parts that
 * touch the world.
 */
export class DaemonOrphanReconciler {
  /** Holds the one-shot warm-up timer first, then the repeating one. Node hands both the same
   *  handle type, so one field clears either. */
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  /** Ephemeral by design: the durable half is the ownership record, and a suspicion that survived
   *  a daemon restart would be a first observation wearing a second one's clothes. */
  private pendingConfirmations = new Set<string>()

  constructor(private readonly options: DaemonOrphanReconcilerOptions) {}

  /** POSIX only: identity is a pid plus its `ps` start time, and on
   *  Windows a PTY's descendants are held by its job object, which teardown already terminates. */
  private get supported(): boolean {
    return (this.options.platform ?? process.platform) !== 'win32'
  }

  start(): void {
    if (!this.supported || this.timer || this.stopped) {
      return
    }
    const intervalMs = this.options.intervalMs ?? ORPHAN_RECONCILE_INTERVAL_MS
    const initialDelay = this.options.initialDelayMs ?? ORPHAN_RECONCILE_INITIAL_DELAY_MS
    const first = setTimeout(() => {
      if (this.stopped) {
        return
      }
      void this.runOnce()
      const repeating = setInterval(() => void this.runOnce(), intervalMs)
      repeating.unref?.()
      this.timer = repeating
    }, initialDelay)
    // Unref'd so this timer can never be the reason an idle daemon stays alive.
    first.unref?.()
    this.timer = first
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One reconciliation pass. Exposed so tests drive ticks directly instead of waiting on a clock. */
  async runOnce(): Promise<void> {
    if (!this.supported || this.running) {
      return
    }
    this.running = true
    try {
      await this.reconcile()
    } catch (error) {
      // A reconciler that throws into the daemon's timer queue would be worse than one that misses
      // a tick; the next tick re-derives everything from scratch anyway.
      this.options.log('pty-orphan-reconcile-failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.running = false
    }
  }

  private async reconcile(): Promise<void> {
    let stored = this.options.store.read()
    if (stored.status !== 'readable') {
      // Refusing to act on an unreadable store is the safe direction: an empty read would look
      // exactly like "this daemon never owned anything".
      this.options.log('pty-orphan-records-unreadable')
      return
    }
    const legacyStores = this.options.listLegacyStores?.() ?? []
    if (stored.records.length === 0 && legacyStores.length === 0) {
      this.pendingConfirmations.clear()
      return
    }
    const capture: ProcessTableCapture = await (this.options.readTable ?? readFreshProcessTable)(
      PROCESS_TABLE_TIMEOUT_MS
    )
    if (capture.rows.length === 0) {
      // An empty process table is a broken capture, not a machine with no processes.
      this.options.log('pty-orphan-process-table-empty')
      return
    }
    const selfPid = this.options.selfPid ?? process.pid
    const nowMs = (this.options.now ?? Date.now)()
    if (legacyStores.length > 0) {
      const adopted = adoptLegacyPtyOwnershipStores({
        paths: legacyStores,
        into: this.options.store,
        table: capture.rows,
        selfPid,
        daemonStartToleranceMs: DAEMON_START_TOLERANCE_MS,
        nowMs,
        maxRecordAgeMs: ORPHAN_RECORD_MAX_AGE_MS,
        log: this.options.log
      })
      if (adopted > 0) {
        stored = this.options.store.read()
        if (stored.status !== 'readable') {
          return
        }
      }
    }
    const plan = planOrphanReap({
      records: stored.records,
      liveSessions: this.options.listLiveSessions(),
      table: capture.rows,
      capturedAtMs: capture.capturedAtMs,
      selfPid,
      selfStartedAtMs: this.options.daemonStartedAtMs,
      pendingConfirmations: this.pendingConfirmations,
      nowMs,
      spawnGraceMs: ORPHAN_SPAWN_GRACE_MS,
      maxRecordAgeMs: ORPHAN_RECORD_MAX_AGE_MS,
      daemonStartToleranceMs: DAEMON_START_TOLERANCE_MS
    })
    this.pendingConfirmations = new Set(plan.confirmNext)
    for (const target of plan.reap) {
      this.reapTarget(target, capture.capturedAtMs)
    }
    this.persist(plan)
    this.logSummary(plan, stored.records.length)
  }

  private reapTarget(target: OrphanReapTarget, capturedAtMs: number): void {
    const pids = target.members.map((row) => row.pid)
    this.options.log('pty-orphan-reap', {
      sessionId: target.sessionId,
      incarnationId: target.incarnationId,
      reason: target.reason,
      pgids: cap(target.pgids),
      pids: cap(pids),
      processCount: pids.length,
      unverifiedGroupMembers: target.unverifiedGroupMembers
    })
    if (this.options.terminateMembers) {
      this.options.terminateMembers(target, capturedAtMs)
      return
    }
    // Reuses the sweep teardown already runs: SIGTERM every member now, then after a grace window
    // SIGKILL only those whose pid, start time and process group still match what was signalled.
    //
    // Both scan knobs are overridden rather than inherited. Teardown's defaults are sized for a
    // user waiting on a close: one shared, coalescing capture under a one-second deadline. A
    // loaded host blows that deadline — `ps` measures 1.9-2.7s at load 87 against 0.12s idle — and
    // `terminateDescendantSnapshot` then simply never escalates, so a process ignoring SIGTERM
    // survives with nothing logged. Nothing waits on this sweep, so it gets its own scan and a
    // deadline sized for a background job.
    terminateDescendantSnapshot(
      { rootPgid: null, descendants: target.members, capturedAtMs },
      {
        readTable: this.options.escalationReadTable ?? readFreshProcessTable,
        timeoutMs: PROCESS_TABLE_TIMEOUT_MS,
        ...(this.options.escalationGraceMs !== undefined
          ? { graceMs: this.options.escalationGraceMs }
          : {})
      }
    )
  }

  private persist(plan: OrphanReapPlan): void {
    // A reaped record is deliberately not dropped here: the kill is asynchronous, and the record
    // is what lets the next tick confirm the processes are actually gone before retiring it.
    this.options.store.applyTick(
      plan.refreshed,
      plan.dropped.map((entry) => entry.key)
    )
  }

  private logSummary(plan: OrphanReapPlan, recordCount: number): void {
    const countDropped = (reason: OrphanRecordDropReason): number =>
      plan.dropped.filter((entry) => entry.reason === reason).length
    const expired = countDropped('expired')
    // `unprovable` is reported even though nothing was signalled: a recorded pid alive under some
    // other identity is the shape a pid-reuse bug would take, and it must be visible.
    const unprovable = countDropped('unprovable')
    if (plan.reap.length === 0 && expired === 0 && unprovable === 0) {
      // Quiet ticks stay quiet: this log is read to find leaks, not to prove the timer fired.
      return
    }
    this.options.log('pty-orphan-reconcile', {
      records: recordCount,
      reaped: plan.reap.length,
      expired,
      unprovable,
      settled: countDropped('settled'),
      pending: plan.confirmNext.length
    })
  }
}
