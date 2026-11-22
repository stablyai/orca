// A terminal worker whose terminal a reboot or a terminal daemon crash took keeps its Dispatch, as a cut
// chat worker does. Under "Resume work on restart" its agent resumes once in its own conversation and the
// Dispatch follows it; without it, the resume is offered to a person beside the cut chats. Only a failed
// or dismissed resume reaches the coordinator, as today's lost-worker alert.

import {
  claimLostWorkerRestart,
  claimWorkerRestartResume,
  isWorkerRestartOffered,
  openWorkerRestartStage,
  WORKER_RESTART_OFFERED_STAGE,
  WORKER_RESTART_RESUMED_STAGE
} from '../../db/worker-dispatch/worker-restart-resume'
import { RestartResumeHolds, type HeldWorker } from './restart-resume-holds'

export {
  RESTART_RESUME_REOPEN_WAIT_MS,
  type TerminalWorkerRestartResumeDeps
} from './restart-resume-holds'

/** How long a pane started again in place has to show its agent before the worker is reported lost. */
export const IN_PLACE_RESTART_RESUME_WAIT_MS = 120_000
/** Held reboot workers reopen once restored terminals are placed, or after this when no window places them. */
export const RESTART_RESUME_STARTUP_WAIT_MS = 120_000

export class TerminalWorkerRestartResume extends RestartResumeHolds {
  private startupSettled = false
  private startupDeadline: { cancel: () => void } | null = null

  /** A held worker is resuming; nothing else reports it. */
  isHeld(dispatchId: string): boolean {
    return this.held.has(dispatchId)
  }

  /** Held, resumed by this start, or waiting on a person: the restart stop report has nothing to say. */
  isResumingThisStart(dispatchId: string): boolean {
    return this.held.has(dispatchId) || this.resumed.has(dispatchId) || this.isOffered(dispatchId)
  }

  /** The terminal is gone with the run that ended: the conversation reopens in a new terminal once
   *  startup has settled. False leaves today's outcome to the caller. */
  holdForReopen(dispatchId: string, fail: () => void): boolean {
    // A pane already starting again in place resumes there; a second terminal would run it twice.
    if (this.held.get(dispatchId)?.inPlace) {
      return true
    }
    // Offered already, maybe before the setting was turned on: only the person's Resume takes it.
    if (!this.deps.resumeWorkOnRestart() || this.isOffered(dispatchId)) {
      return this.offer(dispatchId)
    }
    if (!this.hold(dispatchId, fail)) {
      return false
    }
    if (this.startupSettled) {
      void this.reopen(dispatchId)
    } else {
      // A start whose window never finishes placing terminals must not leave the coordinator waiting.
      this.startupDeadline ??= this.deps.setTimer(
        () => this.settleStartup(),
        RESTART_RESUME_STARTUP_WAIT_MS
      )
    }
    return true
  }

  /** The pane is starting again in place after its process vanished with the daemon; the window's
   *  restore resumes the conversation there, which `observePaneAgents` then binds. */
  holdInPlace(
    dispatchId: string,
    paneKey: string,
    lostIncarnation: string | null,
    fail: () => void
  ): boolean {
    if (this.held.has(dispatchId)) {
      return true
    }
    const offered = !this.deps.resumeWorkOnRestart() || this.isOffered(dispatchId)
    if (!this.hold(dispatchId, fail, offered)) {
      return false
    }
    const worker = this.held.get(dispatchId)!
    // An offer outlives a pane that never shows its agent: Resume then reopens it in a new terminal.
    const expire = () => (worker.offered ? this.held.delete(dispatchId) : this.giveUp(dispatchId))
    worker.inPlace = {
      paneKey,
      lostIncarnation,
      timer: this.deps.setTimer(expire, IN_PLACE_RESTART_RESUME_WAIT_MS)
    }
    // Its agent may have reported before this hold began.
    this.recheckHeldPanes()
    return true
  }

  /** A person chose Resume on an offered worker: the same once-only resume Resume work on restart runs.
   *  True once its agent is back and owns the Dispatch. */
  async resumeOffered(dispatchId: string, fail: () => void): Promise<boolean> {
    const db = this.deps.getDb()
    const pending = this.held.get(dispatchId)
    // Already resuming from another Resume: that one decides.
    if (!db || (pending && !pending.offered)) {
      return pending !== undefined
    }
    const stage = openWorkerRestartStage(db, dispatchId)
    // Resumed already from another client: that resume stands.
    const claim = stage === WORKER_RESTART_OFFERED_STAGE && claimWorkerRestartResume(db, dispatchId)
    if (!claim) {
      return stage === WORKER_RESTART_RESUMED_STAGE
    }
    if (pending) {
      // Its pane has not shown the agent yet: the answer waits until it does, or it is reported lost.
      delete pending.offered
      return new Promise((resolve) => (pending.settled = resolve))
    }
    const worker: HeldWorker = { claim, fail }
    this.held.set(dispatchId, worker)
    const dispatch = db.getDispatchContextById(dispatchId)
    const paneKey = dispatch?.assignee_pane_key ?? ''
    const handle = paneKey ? this.deps.handleForPane(paneKey) : null
    const live = handle ? this.deps.terminalAuthority(handle)?.processIncarnation : undefined
    const bound = live !== undefined && live === dispatch?.process_incarnation
    // Its pane runs its own conversation, bound or restored late: never a second copy, nor another's.
    const inPane = this.deps.paneConversation(paneKey, claim.session.providerSession.id)
    const own = inPane === 'own' || (bound && inPane === 'unknown')
    if (handle && live !== undefined && own) {
      return this.bind(dispatchId, worker, handle, { rebind: !bound }).catch(() => {
        this.giveUp(dispatchId)
        return false
      })
    }
    return this.reopen(dispatchId)
  }

  /** Startup restoration is done: held terminals reopen now, later ones at once. */
  settleStartup(): void {
    this.startupSettled = true
    this.startupDeadline?.cancel()
    this.startupDeadline = null
    for (const [dispatchId, worker] of this.held) {
      if (!worker.inPlace) {
        void this.reopen(dispatchId)
      }
    }
  }

  /** A pane's process changed: an agent that reported its conversation before then is bound now,
   *  since its hooks report a conversation only when it changes. */
  recheckHeldPanes(): void {
    // Runs on every PTY registration and graph sync; nearly always nothing waits.
    if (this.held.size === 0) {
      return
    }
    const panes = new Set(
      [...this.held.values()].flatMap((worker) => worker.inPlace?.paneKey ?? [])
    )
    this.observePaneAgents(
      [...panes].flatMap((paneKey) =>
        this.deps.paneSessions(paneKey).map((sessionId) => ({ paneKey, sessionId }))
      )
    )
  }

  /** Panes whose agent reported its conversation; a held pane's new process takes its Dispatch. */
  observePaneAgents(sessions: readonly { paneKey: string; sessionId: string }[]): void {
    // Runs on every hook status change; nearly always nothing waits.
    if (this.held.size === 0) {
      return
    }
    const reported = new Set(sessions.map(({ paneKey, sessionId }) => `${paneKey}\0${sessionId}`))
    for (const [dispatchId, worker] of this.held) {
      const inPlace = worker.inPlace
      // Only the worker's own conversation in its own pane takes the Dispatch, not another agent there.
      const own = inPlace && `${inPlace.paneKey}\0${worker.claim.session.providerSession.id}`
      if (!inPlace || !own || !reported.has(own)) {
        continue
      }
      const handle = this.deps.handleForPane(inPlace.paneKey)
      const authority = handle ? this.deps.terminalAuthority(handle) : null
      if (!handle || !authority || authority.processIncarnation === inPlace.lostIncarnation) {
        continue
      }
      inPlace.timer.cancel()
      void this.bind(dispatchId, worker, handle).catch(() => this.giveUp(dispatchId))
    }
  }

  private isOffered(dispatchId: string): boolean {
    const db = this.deps.getDb()
    return db !== null && isWorkerRestartOffered(db, dispatchId)
  }

  /** Resume work on restart is off: the resume waits on a person, durably, and nothing happens meanwhile. */
  private offer(dispatchId: string): boolean {
    // Offered before: still offered, and no news that would bring a closed toast back.
    if (this.isOffered(dispatchId)) {
      return true
    }
    const claim = claimLostWorkerRestart(
      this.deps.getDb(),
      dispatchId,
      WORKER_RESTART_OFFERED_STAGE
    )
    if (claim) {
      this.deps.offersChanged()
    }
    return claim !== null
  }

  private hold(dispatchId: string, fail: () => void, offered = false): boolean {
    if (this.held.has(dispatchId)) {
      return true
    }
    const stage = offered ? WORKER_RESTART_OFFERED_STAGE : WORKER_RESTART_RESUMED_STAGE
    const claim = claimLostWorkerRestart(this.deps.getDb(), dispatchId, stage)
    if (!claim) {
      return false
    }
    this.held.set(dispatchId, { claim, fail, ...(offered ? { offered: true as const } : {}) })
    if (offered) {
      this.deps.offersChanged()
    }
    return true
  }
}
