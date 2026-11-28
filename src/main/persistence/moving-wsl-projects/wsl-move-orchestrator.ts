/**
 * The general migration's orchestrator (D3a). Per distro it decides when the move driver runs:
 * on a trigger that already woke the distro (never a background boot, A1), previewing first,
 * deferring while terminals are busy, backing off on transient failures and parking what needs
 * the user. A finished move's distro is checked for R38 (unregistered or replaced). It never moves
 * anything itself; the driver and its journal own every move.
 */
import type { WslMovePreview, WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveUseLocallyResult } from '../../../shared/wsl-move/wsl-moved-project'
import type { WslMoveOrchestratorPorts } from './orchestration/wsl-move-orchestrator-ports'
import {
  readWslMoveFinishedMove,
  runWslMoveOrchestratorStep
} from './orchestration/wsl-move-orchestrator-step'
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
} from './orchestration/wsl-move-orchestrator-transitions'
import {
  applyWslMoveHostAddedByUser,
  applyWslMoveReleasedByUser,
  applyWslMoveUserAction,
  releaseWslMoveForRestore,
  settleWslMoveOrchestratorRecord
} from './orchestration/wsl-move-orchestrator-external-transitions'
import { WslMoveOrchestratorSidecar } from './orchestration/wsl-move-orchestrator-sidecar'
import { pruneWslMoveOrchestratorRecords } from './orchestration/wsl-move-orchestrator-prune'

/** A project opened again within this window does not read the running distros again. */
export const WSL_MOVE_ORCHESTRATOR_PROJECT_OPENED_THROTTLE_MS = 60_000

export class WslMoveOrchestrator {
  private readonly records = new Map<string, WslMoveOrchestratorRecord>()
  private readonly sidecar: WslMoveOrchestratorSidecar
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
    this.sidecar = new WslMoveOrchestratorSidecar(ports)
    this.adopt()
    this.holdListedDistros()
    void this.prune().catch((error: unknown) =>
      console.warn('[wsl-move] Could not prune inactive moves', error)
    )
  }

  /** Merges the sidecar in once it is readable; false while it is not. */
  private adopt(): boolean {
    const now = this.ports.now()
    // An unreadable journal says nothing about whether a move is finished: keep the record.
    const finished = (distro: string) => readWslMoveFinishedMove(this.ports, distro) !== null
    const adopted = this.sidecar.tryAdopt(this.records, (record) =>
      settleWslMoveOrchestratorRecord(record, now, finished(record.distro))
    )
    // Every record, not only the file's: a timer that fired while held must run again.
    for (const [key, record] of adopted ? this.records : []) {
      this.scheduleFor(key, record)
    }
    return adopted
  }

  /** Reads a sidecar the start could not (a sharing violation passes) and saves the merge. */
  private retryLoad(): void {
    if (!this.sidecar.isLoaded && this.adopt()) {
      this.saveAndPublish()
    }
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
    this.retryLoad()
    this.holdListedDistros()
    // An unread sidecar may hold this distro's decline: only the user's own act moves it now.
    if (trigger !== 'user' && this.sidecar.holdsAutomaticSteps(key)) {
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

  /** After a set-aside file, parks each installed distro until the user acts; retried per wake. */
  private holdListedDistros(): void {
    const held = this.sidecar.holdListedDistros(this.records, () => !this.disposed)
    if (!held) {
      return
    }
    const listing: Promise<void> = held
      .then((changed) => (changed ? this.saveAndPublish() : undefined))
      .finally(() => this.inFlight.delete(listing))
    this.inFlight.add(listing)
  }

  /** The user added the distro's host themselves, which takes back a decline. */
  hostAddedByUser(distro: string): void {
    this.retryLoad()
    const key = wslMoveJournalKey(distro)
    const take = (record: WslMoveOrchestratorRecord) =>
      applyWslMoveHostAddedByUser(record, this.ports.now())
    this.sidecar.release(key)
    // Kept even with no record yet, so a decline in a file read later is taken back too.
    this.sidecar.noteWhileUnread(key, take)
    const current = this.records.get(key)
    if (current) {
      this.commit(key, 'user', take(current), undefined, take)
    }
  }

  /**
   * "Use on this computer again" ran for the distro, or the user removed its host: park it until
   * the user adds the host or presses Retry.
   */
  async releasedByUser(distro: string, cause: WslMoveOrchestratorDeclineCause): Promise<void> {
    this.retryLoad()
    const key = wslMoveJournalKey(distro)
    const decline = (record: WslMoveOrchestratorRecord) =>
      applyWslMoveReleasedByUser(record, this.ports.now(), cause)
    this.commit(key, 'user', decline(this.recordFor(key, distro)), undefined, decline)
    await this.prune()
  }

  /**
   * Drops records of distros with neither a WSL host nor bridge projects left: nothing can wake
   * them, and the status line would describe a distro the user no longer has.
   */
  async prune(): Promise<void> {
    const changed = await pruneWslMoveOrchestratorRecords({
      records: this.records,
      isBusy: (key) => this.busy.has(key),
      isDisposed: () => this.disposed,
      isDistroInUse: (distro) => this.ports.isDistroInUse(distro),
      drop: (key) => {
        this.records.delete(key)
        this.timers.get(key)?.()
        this.timers.delete(key)
      }
    })
    if (changed) {
      this.saveAndPublish()
    }
  }

  async userAction(
    distro: string,
    action: WslMoveOrchestratorUserAction,
    options: { unsavedWorkspaceIds?: readonly string[] } = {}
  ): Promise<{ record: WslMoveOrchestratorRecord; release?: WslMoveUseLocallyResult }> {
    this.retryLoad()
    const key = wslMoveJournalKey(distro)
    const current = this.recordFor(key, distro)
    if (this.busy.has(key)) {
      return { record: current }
    }
    if (action !== 'restore') {
      const act = (record: WslMoveOrchestratorRecord) => this.userActionRecord(record, action)
      this.commit(key, 'user', act(current), undefined, act)
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
    const release = await releaseWslMoveForRestore(
      this.ports,
      distro,
      options.unsavedWorkspaceIds ?? []
    ).finally(() => this.busy.delete(key))
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
    this.sidecar.cancelRetryNow()
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

  /** Stores, reports and schedules a record; `replay` re-applies it to a sidecar read later. */
  private commit(
    key: string,
    trigger: WslMoveOrchestratorTrigger,
    next: WslMoveOrchestratorRecord,
    cause?: WslMovePreview | WslMoveResult,
    replay: (record: WslMoveOrchestratorRecord) => WslMoveOrchestratorRecord = () => next
  ): WslMoveOrchestratorRecord {
    const previous = this.records.get(key)
    if (previous === next || sameWslMoveOrchestratorRecord(previous, next)) {
      return previous ?? next
    }
    this.records.set(key, next)
    this.sidecar.noteWhileUnread(key, replay)
    if (trigger === 'user') {
      this.sidecar.release(key)
    }
    // Every new attempt is reported too, so a backoff series shows each failure.
    if (previous?.state.kind !== next.state.kind || previous.attempts !== next.attempts) {
      this.ports.track(trigger, next, cause)
    }
    this.saveAndPublish()
    this.scheduleFor(key, next)
    return next
  }

  private saveAndPublish(): void {
    this.sidecar.save(this.records)
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
