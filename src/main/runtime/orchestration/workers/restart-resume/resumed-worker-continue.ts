// A resumed worker its restart cut mid-turn is asked, once, to go on with what it was doing.

import { AGENT_SESSION_RESTART_CONTINUATION_MESSAGE } from '../../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isWorkerRestartResumeOpen } from '../../db/worker-dispatch/worker-restart-resume'
import type { TerminalWorkerRestartResumeDeps } from './restart-resume-holds'

/** How long a resumed worker cut mid-turn has to take its continue prompt. */
const RESTART_CONTINUE_BUDGET_MS = 60_000
const RESTART_CONTINUE_RETRY_MS = 2_000

export type ResumedWorker = {
  dispatchId: string
  handle: string
  paneKey: string
  agent: TuiAgent
  /** Its composer was seen up already, so the prompt goes now. */
  agentReady: boolean
}

/** Sends the continue prompt; a worker that does not take it is reported resting, so mail continues it. */
export async function continueResumedWorker(
  deps: Pick<
    TerminalWorkerRestartResumeDeps,
    'getDb' | 'waitForAgentReady' | 'sendPrompt' | 'reportResting' | 'setTimer'
  >,
  worker: ResumedWorker
): Promise<void> {
  try {
    if (!(await continueWhenReady(deps, worker))) {
      throw new Error('restart_resume_continue_not_taken')
    }
  } catch (error) {
    console.warn('[orchestration] continuing a resumed terminal worker failed', {
      dispatchId: worker.dispatchId,
      error
    })
    // Its agent is alive in the rebound terminal: the coordinator hears it rests, and mail continues it.
    await deps.reportResting(worker.paneKey).catch(() => undefined)
  }
}

/** A pane started again in place takes input only once its new process is attached and its agent up. */
async function continueWhenReady(
  deps: Parameters<typeof continueResumedWorker>[0],
  { dispatchId, handle, agent, agentReady }: ResumedWorker
): Promise<boolean> {
  const deadline = Date.now() + RESTART_CONTINUE_BUDGET_MS
  while (!agentReady && !(await deps.waitForAgentReady(handle, agent))) {
    if (Date.now() >= deadline) {
      throw new Error('restart_resume_agent_not_ready')
    }
    await new Promise<void>((resolve) => deps.setTimer(resolve, RESTART_CONTINUE_RETRY_MS))
  }
  const db = deps.getDb()
  // Stopped during the wait: the stop owns the outcome, and the agent is not asked to go on.
  if (!db || !isWorkerRestartResumeOpen(db, dispatchId)) {
    return true
  }
  // Sent once, even when it fails: a send can fail after writing, and a second paste could stack
  // a duplicate turn or double the composer text.
  return deps.sendPrompt(
    handle,
    AGENT_SESSION_RESTART_CONTINUATION_MESSAGE,
    `${dispatchId}:restart-continue`
  )
}
