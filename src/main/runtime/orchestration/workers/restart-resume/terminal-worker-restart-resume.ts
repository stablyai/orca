// Under "Resume work on restart", a terminal worker whose terminal a reboot or a terminal daemon crash
// took keeps its Dispatch: its agent resumes once in its own conversation and the Dispatch follows it.
// Only a failed resume reaches the coordinator, as today's lost-worker alert.

import { AGENT_SESSION_RESTART_CONTINUATION_MESSAGE } from '../../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
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
  /** Resolves once the resumed agent takes input; false when it never does. */
  waitForAgentIdle: (handle: string) => Promise<boolean>
  sendPrompt: (handle: string, prompt: string, operationId: string) => Promise<unknown>
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
  private startupSettled = false

  constructor(private readonly deps: TerminalWorkerRestartResumeDeps) {}

  /** A held worker is resuming; nothing else reports it. */
  isHeld(dispatchId: string): boolean {
    return this.held.has(dispatchId)
  }

  /** The terminal is gone with the run that ended: the conversation reopens in a new terminal once
   *  startup has settled. False leaves today's outcome to the caller. */
  holdForReopen(dispatchId: string, fail: () => void): boolean {
    if (!this.hold(dispatchId, fail)) {
      return false
    }
    if (this.startupSettled) {
      this.reopen(dispatchId)
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
    for (const [dispatchId, worker] of this.held) {
      if (!worker.inPlace) {
        this.reopen(dispatchId)
      }
    }
  }

  /** Panes whose agent reported its conversation; a held pane's new process takes its Dispatch. */
  observePaneAgents(sessions: readonly { paneKey: string }[]): void {
    // Runs on every hook status change; nearly always nothing waits.
    if (this.held.size === 0) {
      return
    }
    const reported = new Set(sessions.map(({ paneKey }) => paneKey))
    for (const [dispatchId, worker] of this.held) {
      const inPlace = worker.inPlace
      if (!inPlace || !reported.has(inPlace.paneKey)) {
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
    return true
  }

  private reopen(dispatchId: string): void {
    const worker = this.held.get(dispatchId)
    if (!worker || this.reopening.has(dispatchId)) {
      return
    }
    this.reopening.add(dispatchId)
    const { worktreeId, session } = worker.claim
    void this.deps
      .reopen(worktreeId, session, `${dispatchId}:restart-resume`)
      .then((reopened) => {
        if (!reopened) {
          throw new Error('restart_resume_refused')
        }
        return this.bind(dispatchId, worker, reopened.handle)
      })
      .catch((error: unknown) => {
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
    this.held.delete(dispatchId)
    // A Dispatch its coordinator settled meanwhile keeps that outcome.
    if (!rebindRestartedWorkerTerminal(db, { dispatchId, handle, ...authority })) {
      return
    }
    // A worker at rest or at a prompt was waiting already; only a cut turn is asked to go on.
    if (worker.claim.presence !== 'working') {
      return
    }
    try {
      await this.continueWhenReady(dispatchId, handle)
    } catch (error) {
      console.warn('[orchestration] continuing a resumed terminal worker failed', {
        dispatchId,
        error
      })
      worker.fail()
    }
  }

  /** A pane started again in place takes input only once its new process is attached and its agent up. */
  private async continueWhenReady(dispatchId: string, handle: string): Promise<void> {
    const deadline = Date.now() + RESTART_CONTINUE_BUDGET_MS
    for (;;) {
      try {
        if (!(await this.deps.waitForAgentIdle(handle))) {
          throw new Error('restart_resume_agent_not_ready')
        }
        await this.deps.sendPrompt(
          handle,
          AGENT_SESSION_RESTART_CONTINUATION_MESSAGE,
          `${dispatchId}:restart-continue`
        )
        return
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
    worker.fail()
  }
}
