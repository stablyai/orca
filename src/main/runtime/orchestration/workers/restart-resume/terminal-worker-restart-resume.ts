// Under "Resume work on restart", a terminal worker whose terminal a reboot or a terminal daemon crash
// took keeps its Dispatch: its agent resumes once in its own conversation and the Dispatch follows it.
// Only a failed resume reaches the coordinator, as today's lost-worker alert.

import { AGENT_SESSION_RESTART_CONTINUATION_MESSAGE } from '../../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  claimWorkerRestartResume,
  rebindRestartedWorkerTerminal,
  type WorkerRestartResumeClaim
} from '../../db/worker-dispatch/worker-restart-resume'
import type { WorkerResumeSession } from '../../db/dispatch-context/worker-follow-up-lineage'

/** How long a pane started again in place has to show its agent before the worker is reported lost. */
export const IN_PLACE_RESTART_RESUME_WAIT_MS = 120_000
/** How long a resumed worker cut mid-turn has to take its continue prompt. */
const RESTART_CONTINUE_BUDGET_MS = 60_000
const RESTART_CONTINUE_RETRY_MS = 2_000
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
  /** The resumed worker is up but could not be asked to continue: its coordinator hears it rests. */
  reportResting: (paneKey: string) => Promise<void>
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
}

type HeldWorker = {
  claim: WorkerRestartResumeClaim
  /** Today's outcome for this worker: its Dispatch fails and its coordinator hears it was lost. */
  fail: () => void
  /** The pane being started again in place, and the process it lost. */
  inPlace?: { paneKey: string; lostIncarnation: string | null; timer: { cancel: () => void } }
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

  /** Held now, or resumed by this start: the restart stop report has nothing to say about it. */
  isResumingThisStart(dispatchId: string): boolean {
    return this.held.has(dispatchId) || this.resumed.has(dispatchId)
  }

  /** The terminal is gone with the run that ended: the conversation reopens in a new terminal once
   *  startup has settled. False leaves today's outcome to the caller. */
  holdForReopen(dispatchId: string, fail: () => void): boolean {
    // A pane already starting again in place resumes there; a second terminal would run it twice.
    if (this.held.get(dispatchId)?.inPlace) {
      return true
    }
    if (!this.hold(dispatchId, fail)) {
      return false
    }
    if (this.startupSettled) {
      this.reopen(dispatchId)
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
    if (!this.hold(dispatchId, fail)) {
      return false
    }
    const worker = this.held.get(dispatchId)!
    worker.inPlace = {
      paneKey,
      lostIncarnation,
      timer: this.deps.setTimer(() => this.giveUp(dispatchId), IN_PLACE_RESTART_RESUME_WAIT_MS)
    }
    return true
  }

  /** Startup restoration is done: held terminals reopen now, later ones at once. */
  settleStartup(): void {
    this.startupSettled = true
    this.startupDeadline?.cancel()
    this.startupDeadline = null
    for (const [dispatchId, worker] of this.held) {
      if (!worker.inPlace) {
        this.reopen(dispatchId)
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

  private hold(dispatchId: string, fail: () => void): boolean {
    if (this.held.has(dispatchId)) {
      return true
    }
    const db = this.deps.getDb()
    if (!db || !this.deps.resumeWorkOnRestart()) {
      return false
    }
    let claim: WorkerRestartResumeClaim | null
    try {
      claim = claimWorkerRestartResume(db, dispatchId)
    } catch (error) {
      console.warn('[orchestration] claiming a worker restart resume failed', dispatchId, error)
      return false
    }
    if (!claim) {
      return false
    }
    this.held.set(dispatchId, { claim, fail })
    console.info('[orchestration] holding a terminal worker for its restart resume', {
      dispatchId,
      presence: claim.presence
    })
    return true
  }

  private reopen(dispatchId: string): void {
    const worker = this.held.get(dispatchId)
    if (!worker || this.reopening.has(dispatchId)) {
      return
    }
    this.reopening.add(dispatchId)
    const { worktreeId, session } = worker.claim
    const reopened = this.deps.reopen(worktreeId, session, `${dispatchId}:restart-resume`)
    const timer = this.deps.setTimer(() => {
      console.warn('[orchestration] resuming a terminal worker after a restart timed out', {
        dispatchId
      })
      this.giveUp(dispatchId)
    }, RESTART_RESUME_REOPEN_WAIT_MS)
    void reopened
      .then(async (terminal) => {
        timer.cancel()
        if (!terminal) {
          throw new Error('restart_resume_refused')
        }
        // Late, after this worker was given up: its conversation must not run unowned.
        if (this.held.get(dispatchId) !== worker) {
          await this.deps.closeTerminal(terminal.handle).catch(() => undefined)
          return
        }
        await this.bind(dispatchId, worker, terminal.handle).catch(async (error: unknown) => {
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
      })
      .finally(() => this.reopening.delete(dispatchId))
  }

  private async bind(dispatchId: string, worker: HeldWorker, handle: string): Promise<void> {
    if (this.held.get(dispatchId) !== worker) {
      return
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
      return
    }
    this.held.delete(dispatchId)
    this.resumed.add(dispatchId)
    // A worker at rest or at a prompt was waiting already; only a cut turn is asked to go on.
    if (worker.claim.presence !== 'working') {
      return
    }
    try {
      if (!(await this.continueWhenReady(dispatchId, handle, worker.claim.session.agent))) {
        throw new Error('restart_resume_continue_not_taken')
      }
    } catch (error) {
      console.warn('[orchestration] continuing a resumed terminal worker failed', {
        dispatchId,
        error
      })
      // Its agent is alive in the rebound terminal: the coordinator hears it rests, and mail continues it.
      await this.deps.reportResting(authority.paneKey).catch(() => undefined)
    }
  }

  /** A pane started again in place takes input only once its new process is attached and its agent up. */
  private async continueWhenReady(
    dispatchId: string,
    handle: string,
    agent: TuiAgent
  ): Promise<boolean> {
    const deadline = Date.now() + RESTART_CONTINUE_BUDGET_MS
    for (;;) {
      try {
        if (!(await this.deps.waitForAgentReady(handle, agent))) {
          throw new Error('restart_resume_agent_not_ready')
        }
        // Sent once: a second paste could stack a duplicate turn or double the composer text.
        return await this.deps.sendPrompt(
          handle,
          AGENT_SESSION_RESTART_CONTINUATION_MESSAGE,
          `${dispatchId}:restart-continue`
        )
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error
        }
        await new Promise<void>((resolve) => this.deps.setTimer(resolve, RESTART_CONTINUE_RETRY_MS))
      }
    }
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
