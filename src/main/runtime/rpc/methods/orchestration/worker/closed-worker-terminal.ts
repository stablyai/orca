/** A terminal worker Orca closed keeps its conversation; resume it in a terminal of the user's so any client can open it. */

import { randomUUID } from 'node:crypto'
import { isResumableTuiAgent } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { OrchestrationPartyLocation } from '../../../../../../shared/orchestration-caller-status'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { readWorkerResumeSession } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { userTabHoldingSession } from './worker-follow-up-choice'
import { reopenWorkerTerminal } from './worker-follow-up-placement'

// A resume that failed may still have spawned; its retry keeps the request id so it reconciles that pane.
// Taken before any await, so opens that overlap (desktop and phone) share one request and get one terminal.
const uncertain = new Map<string, string>()

/** Null keeps the lookup's answer: the worker's terminal is still there, or its conversation cannot resume here. */
export async function openClosedWorkerTerminal(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  handle: string
): Promise<OrchestrationPartyLocation | null> {
  const resource = db.getWorkerTerminalResourceByHandle(handle)
  const session = readWorkerResumeSession(resource)
  if (
    !resource?.worktree_id ||
    !session ||
    !isResumableTuiAgent(session.agent) ||
    (resource.ownership_state !== 'released' && resource.release_state !== 'released') ||
    // An issued handle outlives its pane; only a connected PTY means the terminal is still there.
    runtime.getLiveTerminalPaneKey(handle) !== null
  ) {
    return null
  }
  const mutationId = uncertain.get(resource.id) ?? randomUUID()
  uncertain.set(resource.id, mutationId)
  const held = await userTabHoldingSession(runtime, session)
  if (held) {
    // An earlier uncertain resume is settled once its conversation reports.
    uncertain.delete(resource.id)
    return { kind: 'terminal', handle: held }
  }
  const reopened = await reopenWorkerTerminal(runtime, resource.worktree_id, session, mutationId)
  uncertain.delete(resource.id)
  return reopened ? { kind: 'terminal', handle: reopened.handle } : null
}
