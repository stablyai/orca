/**
 * The general migration's orchestrator (D3a). Per distro it decides when the move driver runs:
 * on a trigger that already woke the distro (never a background boot, A1), previewing first,
 * deferring while terminals are busy, backing off on transient failures and parking what needs
 * the user. A finished move's distro is checked for R38 (unregistered or replaced). It never moves
 * anything itself; the driver and its journal own every move.
 */
import type { WslMovePreview, WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveUseLocallyResult } from '../../../shared/wsl-move/wsl-moved-project'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'
import { readWslMoveFinishedMove, runWslMoveOrchestratorStep } from './wsl-move-orchestrator-step'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type {
  WslMoveOrchestratorDeclineCause,
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorTrigger,
  WslMoveOrchestratorUserAction
} from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  newWslMoveOrchestratorRecord,
  sameWslMoveOrchestratorRecord,
  wslMoveOrchestratorTimerDelay
} from './wsl-move-orchestrator-transitions'
import {
  applyWslMoveHostAddedByUser,
  applyWslMoveReleasedByUser,
  applyWslMoveUserAction,
  settleWslMoveOrchestratorRecord
} from './wsl-move-orchestrator-external-transitions'

/** A project opened again within this window does not read the running distros again. */
export const WSL_MOVE_ORCHESTRATOR_PROJECT_OPENED_THROTTLE_MS = 60_000

/**
 * A user's own decision (a decline, or Not now) is never pruned: dropping it would let a later
 * wake undo it, e.g. re-add a host the user removed.
 */
function recordsUserChoice(record: WslMoveOrchestratorRecord): boolean {
  const { state } = record
  return state.kind === 'parked' && (state.reason === 'declined' || state.reason === 'not-now')
}

export class WslMoveOrchestrator {
  private readonly records: Map<string, WslMoveOrchestratorRecord>
  private readonly busy = new Set<string>()
  private readonly timers = new Map<string, () => void>()
  private readonly projectOpenedAt = new Map<string, number>()
  /** A wake that arrived while the distro was busy, run once the current step ends. */
  private readonly queued = new Map<
    string,
    { distro: string; trigger: WslMoveOrchestratorTrigger }
  >()
  private readonly inFlight = new Set<Promise<void>>()
  private disposed = false

  constructor(private readonly ports: WslMoveOrchestratorPorts) {
    const now = ports.now()
    this.records = new Map(
      [...ports.load()].map(([key, record]) => [
        key,
        // An unreadable journal says nothing about whether a move is finished: keep the record.
        settleWslMoveOrchestratorRecord(
          record,
          now,
          readWslMoveFinishedMove(ports, record.distro) !== null
        )
      ])
    )
    for (const [key, record] of this.records) {
      this.scheduleFor(key, record)
    }
    this.prune()
  }

  list(): WslMoveOrchestratorRecord[] {
    return [...this.records.values()]
  }

  /**
   * Runs the distro's next step for a trigger. A wake that arrives mid-step runs once after it;
   * a timer or user trigger then is absorbed (the step it would repeat is under way).
   */
  async trigger(distro: string, trigger: WslMoveOrchestratorTrigger): Promise<void> {
    const key = wslMoveJournalKey(distro)
    if (this.disposed || (trigger !== 'user' && !this.ports.autoMoveEnabled())) {
      return
    }
    if (this.busy.has(key)) {
      if (trigger === 'project-opened' || trigger === 'connect') {
        this.queued.set(key, { distro, trigger })
      }
      return
    }
    if (trigger === 'project-opened') {
      const now = this.ports.now()
      const last = this.projectOpenedAt.get(key)
      if (last !== undefined && now - last < WSL_MOVE_ORCHESTRATOR_PROJECT_OPENED_THROTTLE_MS) {
        return
      }
      this.projectOpenedAt.set(key, now)
    }
    await this.run(key, distro, trigger)
  }

  private async run(
    key: string,
    distro: string,
    trigger: WslMoveOrchestratorTrigger
  ): Promise<void> {
    this.busy.add(key)
    const running = (async () => {
      try {
        // The user's Retry is their act on this distro: the driver's reads may start it, as a
        // click would. Every other trigger stays under the background gates (A1).
        await (trigger === 'user'
          ? this.ports.runAsUserAct(distro, () => this.step(key, distro, trigger))
          : this.step(key, distro, trigger))
      } catch (error) {
        // Triggers are fire-and-forget (status events, timers): a throw must not go unhandled.
        console.warn('[wsl-move] Orchestrator step failed:', error)
      } finally {
        this.busy.delete(key)
        // In `finally`, so a step that throws never strands the wake queued behind it.
        await this.replayQueued(key)
      }
    })()
    this.inFlight.add(running)
    try {
      await running
    } finally {
      this.inFlight.delete(running)
    }
  }

  /** Resolves once no step is running; the IPC never waits on a move, so tests and quit do. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(this.inFlight)
    }
  }

  /** Runs the wake that arrived while the distro was busy, once it no longer is. */
  private async replayQueued(key: string): Promise<void> {
    const queued = this.queued.get(key)
    if (queued && !this.disposed && !this.busy.has(key)) {
      this.queued.delete(key)
      await this.run(key, queued.distro, queued.trigger)
    }
  }

  /** The user added the distro's host themselves, which takes back a decline. */
  hostAddedByUser(distro: string): void {
    const key = wslMoveJournalKey(distro)
    const current = this.records.get(key)
    if (current) {
      this.commit(key, 'user', applyWslMoveHostAddedByUser(current, this.ports.now()))
    }
  }

  /**
   * "Use on this computer again" ran for the distro, or the user removed its host: park it until
   * the user adds the host or presses Retry.
   */
  releasedByUser(distro: string, cause: WslMoveOrchestratorDeclineCause): void {
    const key = wslMoveJournalKey(distro)
    this.commit(
      key,
      'user',
      applyWslMoveReleasedByUser(this.recordFor(key, distro), this.ports.now(), cause)
    )
    this.prune()
  }

  /**
   * Drops records of distros with neither a WSL host nor bridge projects left: nothing can wake
   * them, and the status line would describe a distro the user no longer has.
   */
  prune(): void {
    let changed = false
    for (const [key, record] of this.records) {
      if (
        !this.busy.has(key) &&
        record.state.kind !== 'moving' &&
        !recordsUserChoice(record) &&
        !this.ports.isDistroInUse(record.distro)
      ) {
        this.records.delete(key)
        this.timers.get(key)?.()
        this.timers.delete(key)
        changed = true
      }
    }
    if (changed) {
      this.saveAndPublish()
    }
  }

  async userAction(
    distro: string,
    action: WslMoveOrchestratorUserAction,
    options: { unsavedWorkspaceIds?: readonly string[] } = {}
  ): Promise<{ record: WslMoveOrchestratorRecord; release?: WslMoveUseLocallyResult }> {
    const key = wslMoveJournalKey(distro)
    const current = this.recordFor(key, distro)
    if (this.busy.has(key)) {
      return { record: current }
    }
    if (action !== 'restore') {
      this.commit(key, 'user', this.userActionRecord(current, action))
      if (action !== 'not-now') {
        // The reply carries the new state; the move itself reports through status events.
        void this.trigger(distro, 'user')
      }
      return { record: this.recordFor(key, distro) }
    }
    if (current.state.kind !== 'restore-offered') {
      return { record: current }
    }
    this.busy.add(key)
    let release: WslMoveUseLocallyResult
    try {
      release = await this.ports.releaseFinishedMove(distro, options.unsavedWorkspaceIds ?? [])
    } catch (error) {
      release = {
        released: false,
        reason: 'failed',
        detail: error instanceof Error ? error.message : 'restore_failed'
      }
    } finally {
      this.busy.delete(key)
    }
    if (release.released) {
      this.commit(key, 'user', this.userActionRecord(current, action))
    }
    // A wake that came in during the release runs now, as after any step, without holding the reply.
    void this.replayQueued(key)
    return { record: this.recordFor(key, distro), release }
  }

  private userActionRecord(
    record: WslMoveOrchestratorRecord,
    action: WslMoveOrchestratorUserAction
  ): WslMoveOrchestratorRecord {
    return applyWslMoveUserAction(record, action, this.ports.now(), this.ports.appVersion)
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.timers.values()) {
      cancel()
    }
    this.timers.clear()
  }

  private recordFor(key: string, distro: string): WslMoveOrchestratorRecord {
    return (
      this.records.get(key) ??
      newWslMoveOrchestratorRecord(distro, this.ports.appVersion, this.ports.now())
    )
  }

  /**
   * True when the record changed under an await (the user released the move, or chose Not now):
   * the step's view is stale and must not overwrite the user's choice.
   */
  private changedUnder(key: string, seen: WslMoveOrchestratorRecord): boolean {
    const current = this.records.get(key)
    return current !== undefined && current !== seen
  }

  private step(key: string, distro: string, trigger: WslMoveOrchestratorTrigger): Promise<void> {
    return runWslMoveOrchestratorStep(
      {
        ports: this.ports,
        record: this.recordFor(key, distro),
        changedUnder: (seen) => this.changedUnder(key, seen),
        commit: (next, cause) => this.commit(key, trigger, next, cause)
      },
      distro,
      trigger
    )
  }

  /** Stores, reports and schedules a record; unchanged records cost nothing. */
  private commit(
    key: string,
    trigger: WslMoveOrchestratorTrigger,
    next: WslMoveOrchestratorRecord,
    cause?: WslMovePreview | WslMoveResult
  ): WslMoveOrchestratorRecord {
    const previous = this.records.get(key)
    if (previous === next || sameWslMoveOrchestratorRecord(previous, next)) {
      return previous ?? next
    }
    this.records.set(key, next)
    // Every new attempt is reported too, so a backoff series shows each failure.
    if (previous?.state.kind !== next.state.kind || previous.attempts !== next.attempts) {
      this.ports.track(trigger, next, cause)
    }
    this.saveAndPublish()
    this.scheduleFor(key, next)
    return next
  }

  private saveAndPublish(): void {
    try {
      this.ports.save(this.records)
    } catch (error) {
      // The sidecar is the orchestrator's memory, not the move's record: keep going in memory.
      console.warn('[wsl-move] Orchestrator state not saved:', error)
    }
    this.ports.publish(this.list())
  }

  private scheduleFor(key: string, record: WslMoveOrchestratorRecord): void {
    this.timers.get(key)?.()
    this.timers.delete(key)
    const delay = wslMoveOrchestratorTimerDelay(record, this.ports.now())
    if (delay === null || this.disposed) {
      return
    }
    this.timers.set(
      key,
      this.ports.schedule(delay, () => {
        this.timers.delete(key)
        void this.trigger(record.distro, 'timer')
      })
    )
  }
}
