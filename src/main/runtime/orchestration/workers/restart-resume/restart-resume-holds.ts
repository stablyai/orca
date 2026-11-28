// The workers a restart resume holds: each reopens or binds once, and ends bound or given up.

import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeTerminalPromptSubmitHold } from '../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { continueResumedWorker } from './resumed-worker-continue'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  isWorkerRestartResumeOpen,
  rebindRestartedWorkerTerminal,
  type WorkerRestartResumeClaim
} from '../../db/worker-dispatch/worker-restart-resume'
import type { WorkerResumeSession } from '../../db/dispatch-context/worker-follow-up-lineage'

/** A reopen that never answers is a lost worker, not a coordinator left waiting. */
export const RESTART_RESUME_REOPEN_WAIT_MS = 90_000
/** Conversations reopened at once; a restart that took many workers starts them a few at a time. */
const RESTART_RESUME_REOPEN_CONCURRENCY = 3

export type TerminalWorkerRestartResumeDeps = {
  getDb: () => OrchestrationDb | null
  resumeWorkOnRestart: () => boolean
  /** Resumes the conversation in a new terminal of the workspace; null when it cannot. */
  reopen: (
    worktreeId: string,
    session: WorkerResumeSession,
    mutationId: string,
    dispatchId: string
  ) => Promise<{ handle: string } | null>
  terminalAuthority: (
    handle: string
  ) => { paneKey: string; processIncarnation: string; hostScope?: string } | null
  handleForPane: (paneKey: string) => string | null
  /** What this pane's live agent runs, as far as its hooks have said. */
  paneConversation: (paneKey: string, sessionId: string) => 'own' | 'other' | 'unknown'
  /** The conversations this pane's live agent reported. */
  paneSessions: (paneKey: string) => readonly string[]
  /** Resolves once the resumed agent's composer takes input; false when it never does. */
  waitForAgentReady: (handle: string, agent: TuiAgent) => Promise<boolean>
  /** False when the agent provably did not start the turn; the hold when Orca left it unsubmitted. */
  sendPrompt: (
    handle: string,
    prompt: string,
    operationId: string
  ) => Promise<boolean | { withheldFor: RuntimeTerminalPromptSubmitHold }>
  /** The continue prompt waits unsent behind a dialog or typing: its coordinator is told once. */
  reportContinueWithheld: (
    dispatchId: string,
    handle: string,
    hold: RuntimeTerminalPromptSubmitHold
  ) => Promise<void>
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

export type HeldWorker = {
  claim: WorkerRestartResumeClaim
  /** Today's outcome for this worker: its Dispatch fails and its coordinator hears it was lost. */
  fail: () => void
  /** The pane being started again in place, and the process it lost. */
  inPlace?: { paneKey: string; lostIncarnation: string | null; timer: { cancel: () => void } }
  /** Offered to a person: its pane's new process takes the Dispatch, but nothing asks it to go on. */
  offered?: true
  /** A person's Resume waiting on this worker: told whether its agent came back. */
  settled?: (resumed: boolean) => void
  /** That Resume's answer, which a repeat Resume shares. */
  answer?: Promise<boolean>
}

export abstract class RestartResumeHolds {
  protected readonly held = new Map<string, HeldWorker>()
  private readonly reopening = new Set<string>()
  /** Dispatches this start resumed: the restart's own stop report leaves them to their new terminal. */
  protected readonly resumed = new Set<string>()
  private reopensRunning = 0
  private readonly reopenQueue: (() => void)[] = []

  constructor(protected readonly deps: TerminalWorkerRestartResumeDeps) {}

  /** A person dismissed this worker: no resume of it settles later. */
  forget(dispatchId: string): void {
    const worker = this.held.get(dispatchId)
    this.held.delete(dispatchId)
    worker?.inPlace?.timer.cancel()
    worker?.settled?.(false)
  }

  protected async reopen(dispatchId: string): Promise<boolean> {
    const worker = this.held.get(dispatchId)
    if (!worker || this.reopening.has(dispatchId)) {
      return false
    }
    this.reopening.add(dispatchId)
    await this.reopenSlot()
    try {
      return await this.reopenNow(dispatchId, worker)
    } finally {
      this.reopening.delete(dispatchId)
      this.reopensRunning -= 1
      this.reopenQueue.shift()?.()
    }
  }

  private reopenSlot(): Promise<void> {
    if (this.reopensRunning < RESTART_RESUME_REOPEN_CONCURRENCY) {
      this.reopensRunning += 1
      return Promise.resolve()
    }
    return new Promise((resolve) =>
      this.reopenQueue.push(() => {
        this.reopensRunning += 1
        resolve()
      })
    )
  }

  private reopenNow(dispatchId: string, worker: HeldWorker): Promise<boolean> {
    const db = this.deps.getDb()
    // Stopped, released or dismissed while it waited: nothing starts, and today's outcome settles it.
    if (this.held.get(dispatchId) !== worker || !db || !isWorkerRestartResumeOpen(db, dispatchId)) {
      this.giveUp(dispatchId)
      return Promise.resolve(false)
    }
    const { worktreeId, session } = worker.claim
    const reopened = this.deps.reopen(
      worktreeId,
      session,
      `${dispatchId}:restart-resume`,
      dispatchId
    )
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
          ? this.bind(dispatchId, worker, terminal.handle, { agentReady: true })
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
    // A reopen that never answers settles as given up, not as a caller left waiting.
    return Promise.race([
      resumed,
      new Promise<boolean>((resolve) => (timedOut = () => resolve(false)))
    ])
  }

  protected async bind(
    dispatchId: string,
    worker: HeldWorker,
    handle: string,
    { agentReady = false, rebind = true }: { agentReady?: boolean; rebind?: boolean } = {}
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
    if (rebind && !rebindRestartedWorkerTerminal(db, { dispatchId, handle, ...authority })) {
      this.held.delete(dispatchId)
      worker.settled?.(false)
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
    worker.settled?.(true)
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

  protected giveUp(dispatchId: string): void {
    const worker = this.held.get(dispatchId)
    if (!worker) {
      return
    }
    this.held.delete(dispatchId)
    worker.inPlace?.timer.cancel()
    worker.settled?.(false)
    console.warn('[orchestration] a terminal worker was not resumed after a restart', {
      dispatchId
    })
    worker.fail()
  }
}
