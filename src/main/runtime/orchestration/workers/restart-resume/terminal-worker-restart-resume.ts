// A terminal worker whose terminal a reboot or a terminal daemon crash took keeps its Dispatch, as a cut
// chat worker does. Under "Resume work on restart" its agent resumes once in its own conversation and the
// Dispatch follows it; without it, the resume is offered to a person beside the cut chats. Only a failed
// or dismissed resume reaches the coordinator, as today's lost-worker alert.

import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { continueResumedWorker } from './resumed-worker-continue'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  claimLostWorkerRestart,
  claimWorkerRestartResume,
  isWorkerRestartOffered,
  isWorkerRestartResumeOpen,
  rebindRestartedWorkerTerminal,
  WORKER_RESTART_OFFERED_STAGE,
  WORKER_RESTART_RESUMED_STAGE,
  type WorkerRestartResumeClaim
} from '../../db/worker-dispatch/worker-restart-resume'
import type { WorkerResumeSession } from '../../db/dispatch-context/worker-follow-up-lineage'

/** How long a pane started again in place has to show its agent before the worker is reported lost. */
export const IN_PLACE_RESTART_RESUME_WAIT_MS = 120_000
/** Held reboot workers reopen once restored terminals are placed, or after this when no window places them. */
export const RESTART_RESUME_STARTUP_WAIT_MS = 120_000
/** A reopen that never answers is a lost worker, not a coordinator left waiting. */
export const RESTART_RESUME_REOPEN_WAIT_MS = 90_000

export type TerminalWorkerRestartResumeDeps = {
  getDb: () => OrchestrationDb | null
  resumeWorkOnRestart: () => boolean
  /** Resumes the conversation in a new terminal of the workspace; null when it cannot. */
  reopen: (
    worktreeId: string,
    session: WorkerResumeSession,
    mutationId: string
  ) => Promise<{ handle: string } | null>
  terminalAuthority: (
    handle: string
  ) => { paneKey: string; processIncarnation: string; hostScope?: string } | null
  handleForPane: (paneKey: string) => string | null
  /** Resolves once the resumed agent's composer takes input; false when it never does. */
  waitForAgentReady: (handle: string, agent: TuiAgent) => Promise<boolean>
  /** False when the agent provably did not start the turn. */
  sendPrompt: (handle: string, prompt: string, operationId: string) => Promise<boolean>
  /** A terminal this resume opened for a Dispatch that settled meanwhile; nobody owns its agent. */
  closeTerminal: (handle: string) => Promise<unknown>
  /** Decides again a rest the worker's report was held back for; no wait outlives its lost terminal. */
  decideHeldRest: (dispatchId: string) => void
  /** The resumed worker is up but could not be asked to continue: its coordinator hears it rests. */
  reportResting: (paneKey: string) => Promise<void>
  /** A resume now waits on a person: the restart offer is read again where it is shown. */
  offersChanged: () => void
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
}

type HeldWorker = {
  claim: WorkerRestartResumeClaim
  /** Today's outcome for this worker: its Dispatch fails and its coordinator hears it was lost. */
  fail: () => void
  /** The pane being started again in place, and the process it lost. */
  inPlace?: { paneKey: string; lostIncarnation: string | null; timer: { cancel: () => void } }
  /** Offered to a person: its pane's new process takes the Dispatch, but nothing asks it to go on. */
  offered?: true
}

export class TerminalWorkerRestartResume {
  private readonly held = new Map<string, HeldWorker>()
  private readonly reopening = new Set<string>()
  /** Dispatches this start resumed: the restart's own stop report leaves them to their new terminal. */
  private readonly resumed = new Set<string>()
  private startupSettled = false
  private startupDeadline: { cancel: () => void } | null = null

  constructor(private readonly deps: TerminalWorkerRestartResumeDeps) {}

  /** A held worker is resuming; nothing else reports it. */
  isHeld(dispatchId: string): boolean {
    return this.held.has(dispatchId)
  }

  /** Held, resumed by this start, or waiting on a person: the restart stop report has nothing to say. */
  isResumingThisStart(dispatchId: string): boolean {
    const db = this.deps.getDb()
    return (
      this.held.has(dispatchId) ||
      this.resumed.has(dispatchId) ||
      (db !== null && isWorkerRestartOffered(db, dispatchId))
    )
  }

  /** The terminal is gone with the run that ended: the conversation reopens in a new terminal once
   *  startup has settled. False leaves today's outcome to the caller. */
  holdForReopen(dispatchId: string, fail: () => void): boolean {
    // A pane already starting again in place resumes there; a second terminal would run it twice.
    if (this.held.get(dispatchId)?.inPlace) {
      return true
    }
    if (!this.deps.resumeWorkOnRestart()) {
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
    const offered = !this.deps.resumeWorkOnRestart()
    if (!this.hold(dispatchId, fail, offered)) {
      return false
    }
    const worker = this.held.get(dispatchId)!
    // An offer outlives a pane that never shows its agent: Resume then reopens it in a new terminal.
    const expire = () => (offered ? this.held.delete(dispatchId) : this.giveUp(dispatchId))
    worker.inPlace = {
      paneKey,
      lostIncarnation,
      timer: this.deps.setTimer(expire, IN_PLACE_RESTART_RESUME_WAIT_MS)
    }
    return true
  }

  /** A person chose Resume on an offered worker: the same once-only resume Resume work on restart runs.
   *  True once its agent is back and owns the Dispatch. */
  async resumeOffered(dispatchId: string, fail: () => void): Promise<boolean> {
    const pending = this.held.get(dispatchId)
    if (pending?.offered) {
      // Its pane has not shown the agent yet: it goes on when it does.
      delete pending.offered
      return true
    }
    const db = this.deps.getDb()
    const claim =
      db && isWorkerRestartOffered(db, dispatchId) && claimWorkerRestartResume(db, dispatchId)
    if (!db || !claim || this.held.has(dispatchId)) {
      return false
    }
    const worker: HeldWorker = { claim, fail }
    this.held.set(dispatchId, worker)
    // A pane started again in place already runs its own conversation and owns the Dispatch.
    const dispatch = db.getDispatchContextById(dispatchId)
    const handle = dispatch?.assignee_pane_key
      ? this.deps.handleForPane(dispatch.assignee_pane_key)
      : null
    if (
      handle &&
      this.deps.terminalAuthority(handle)?.processIncarnation === dispatch?.process_incarnation
    ) {
      return this.bind(dispatchId, worker, handle).catch(() => {
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

  /** Resume work on restart is off: the resume waits on a person, durably, and nothing happens meanwhile. */
  private offer(dispatchId: string): boolean {
    const claim = this.claim(dispatchId, true)
    if (claim) {
      this.deps.offersChanged()
    }
    return claim !== null
  }

  private hold(dispatchId: string, fail: () => void, offered = false): boolean {
    if (this.held.has(dispatchId)) {
      return true
    }
    const claim = this.claim(dispatchId, offered)
    if (!claim) {
      return false
    }
    this.held.set(dispatchId, { claim, fail, ...(offered ? { offered: true as const } : {}) })
    if (offered) {
      this.deps.offersChanged()
    }
    return true
  }

  private claim(dispatchId: string, offered: boolean): WorkerRestartResumeClaim | null {
    const stage = offered ? WORKER_RESTART_OFFERED_STAGE : WORKER_RESTART_RESUMED_STAGE
    return claimLostWorkerRestart(this.deps.getDb(), dispatchId, stage)
  }

  private async reopen(dispatchId: string): Promise<boolean> {
    const worker = this.held.get(dispatchId)
    if (!worker || this.reopening.has(dispatchId)) {
      return false
    }
    const db = this.deps.getDb()
    // Stopped or released while startup settled: nothing starts, and today's outcome settles it.
    if (!db || !isWorkerRestartResumeOpen(db, dispatchId)) {
      this.giveUp(dispatchId)
      return false
    }
    this.reopening.add(dispatchId)
    const { worktreeId, session } = worker.claim
    const reopened = this.deps.reopen(worktreeId, session, `${dispatchId}:restart-resume`)
    let timedOut: (() => void) | undefined
    const timer = this.deps.setTimer(() => {
      console.warn('[orchestration] resuming a terminal worker after a restart timed out', {
        dispatchId
      })
      this.giveUp(dispatchId)
      timedOut?.()
    }, RESTART_RESUME_REOPEN_WAIT_MS)
    const resumed = reopened
      .then(async (terminal) => {
        timer.cancel()
        if (!terminal) {
          throw new Error('restart_resume_refused')
        }
        // Late, after this worker was given up: its conversation must not run unowned.
        if (this.held.get(dispatchId) !== worker) {
          await this.deps.closeTerminal(terminal.handle).catch(() => undefined)
          return false
        }
        // The tab can open as a bare shell; only an agent that came up takes the Dispatch.
        const agentUp = await this.deps.waitForAgentReady(terminal.handle, session.agent)
        const bound = agentUp
          ? this.bind(dispatchId, worker, terminal.handle, true)
          : Promise.reject(new Error('restart_resume_agent_not_ready'))
        return bound.catch(async (error: unknown) => {
          // The conversation runs in a terminal no Dispatch owns: close it before reporting the worker lost.
          await this.deps.closeTerminal(terminal.handle).catch(() => undefined)
          throw error
        })
      })
      .catch((error: unknown) => {
        timer.cancel()
        console.warn('[orchestration] resuming a terminal worker after a restart failed', {
          dispatchId,
          error
        })
        this.giveUp(dispatchId)
        return false
      })
      .finally(() => this.reopening.delete(dispatchId))
    // A reopen that never answers settles as given up, not as a caller left waiting.
    return Promise.race([
      resumed,
      new Promise<boolean>((resolve) => (timedOut = () => resolve(false)))
    ])
  }

  private async bind(
    dispatchId: string,
    worker: HeldWorker,
    handle: string,
    agentReady = false
  ): Promise<boolean> {
    if (this.held.get(dispatchId) !== worker) {
      return false
    }
    const db = this.deps.getDb()
    const authority = this.deps.terminalAuthority(handle)
    if (!db || !authority) {
      throw new Error('restart_resume_unbound')
    }
    // A Dispatch its coordinator settled meanwhile keeps that outcome.
    if (!rebindRestartedWorkerTerminal(db, { dispatchId, handle, ...authority })) {
      this.held.delete(dispatchId)
      if (!worker.inPlace) {
        await this.deps.closeTerminal(handle).catch(() => undefined)
      }
      return false
    }
    this.held.delete(dispatchId)
    // Still offered: the person's Resume decides whether it goes on.
    if (worker.offered) {
      return true
    }
    this.resumed.add(dispatchId)
    // A worker at rest or at a prompt was waiting already; only a cut turn is asked to go on.
    if (worker.claim.presence !== 'working') {
      // The restart's own pass skipped it while resuming: a report a wait held back goes out now.
      this.deps.decideHeldRest(dispatchId)
      return true
    }
    await continueResumedWorker(this.deps, {
      dispatchId,
      handle,
      paneKey: authority.paneKey,
      agent: worker.claim.session.agent,
      agentReady
    })
    return true
  }

  private giveUp(dispatchId: string): void {
    const worker = this.held.get(dispatchId)
    if (!worker) {
      return
    }
    this.held.delete(dispatchId)
    worker.inPlace?.timer.cancel()
    console.warn('[orchestration] a terminal worker was not resumed after a restart', {
      dispatchId
    })
    worker.fail()
  }
}
