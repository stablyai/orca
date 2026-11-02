/** A terminal worker Orca closed keeps its conversation; resume it in a terminal of the user's so any client can open it. */

import { randomUUID } from 'node:crypto'
import { isResumableTuiAgent } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { OrchestrationPartyLocation } from '../../../../../../shared/orchestration-caller-status'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { readWorkerResumeSession } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { userTabHoldingSession } from './worker-follow-up-choice'
import { reopenWorkerTerminal } from './worker-follow-up-placement'

const opening = new Map<string, Promise<OrchestrationPartyLocation | null>>()
// Until its agent reports, a resumed pane is known only by the handle or request this host made.
const attempts = new Map<string, { mutationId: string; handle?: string }>()

/** Null keeps the lookup's answer: the worker's terminal is still there, or its conversation cannot resume here. */
export function openClosedWorkerTerminal(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  handle: string
): Promise<OrchestrationPartyLocation | null> {
  const resource = db.getWorkerTerminalResourceByHandle(handle)
  if (!resource) {
    return Promise.resolve(null)
  }
  // Desktop and phone may click at once; both get the one terminal.
  const inFlight = opening.get(resource.id)
  if (inFlight) {
    return inFlight
  }
  const open = (async (): Promise<OrchestrationPartyLocation | null> => {
    const session = readWorkerResumeSession(resource)
    if (
      !resource.worktree_id ||
      !session ||
      !isResumableTuiAgent(session.agent) ||
      (resource.ownership_state !== 'released' && resource.release_state !== 'released') ||
      // An issued handle outlives its pane; only a connected PTY means the terminal is still there.
      runtime.getLiveTerminalPaneKey(handle) !== null
    ) {
      return null
    }
    const earlier = attempts.get(resource.id)
    // A shell the agent exited from no longer holds the conversation; resume it again instead.
    if (earlier?.handle && (await runtime.isTerminalRunningAgent(earlier.handle))) {
      return { kind: 'terminal', handle: earlier.handle }
    }
    const held = await userTabHoldingSession(runtime, session)
    if (held) {
      return { kind: 'terminal', handle: held }
    }
    // A failed request keeps its id, so a retry reconciles the pane it may have started.
    const mutationId = earlier && !earlier.handle ? earlier.mutationId : randomUUID()
    attempts.set(resource.id, { mutationId })
    const reopened = await reopenWorkerTerminal(runtime, resource.worktree_id, session, mutationId)
    if (!reopened) {
      return null
    }
    attempts.set(resource.id, { mutationId, handle: reopened.handle })
    return { kind: 'terminal', handle: reopened.handle }
  })().finally(() => opening.delete(resource.id))
  opening.set(resource.id, open)
  return open
}
