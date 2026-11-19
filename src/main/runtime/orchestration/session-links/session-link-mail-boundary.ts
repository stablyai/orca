import {
  isOrcaSessionId,
  type OrcaSessionId
} from '../../../../shared/agent-session/identity/orca-session-address'
import type { SessionLink } from '../../../../shared/session-link'
import type { OrchestrationDb } from '../db/orchestration-db'
import { currentRunCoordinatorOrcaSessionId } from '../db/runs/run-coordinator-orca-session'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import { resolveOrchestrationParty } from '../addressing/orchestration-party'
import { OrchestrationError } from '../orchestration-error'
import { sessionLinks } from './worker/session-link-worker-client'

export type SessionLinkMailBoundary = { assert(to: string): void }

/** The sender's link, read once, so a send can check each recipient where it resolves it. */
export async function sessionLinkMailBoundary(
  db: OrchestrationDb,
  sender: string | null | undefined
): Promise<SessionLinkMailBoundary> {
  const linked = sender && isOrcaSessionId(sender) ? sender : null
  const link = linked ? await sessionLinks(db).forSession(canonicalOrcaSessionId(linked)) : null
  return {
    assert: (to) => {
      if (linked && link) {
        assertOutsideLink(db, link, linked, to)
      }
    }
  }
}

export async function assertSessionLinkMailBoundary(
  db: OrchestrationDb,
  sender: string | null | undefined,
  to: string
): Promise<void> {
  ;(await sessionLinkMailBoundary(db, sender)).assert(to)
}

function assertOutsideLink(
  db: OrchestrationDb,
  link: SessionLink,
  sender: OrcaSessionId,
  to: string
): void {
  let recipient: string | null | undefined
  if (to.startsWith('run:')) {
    const run = db.getRun(to.slice(4))
    recipient = run
      ? (currentRunCoordinatorOrcaSessionId(run) ??
        (run.coordinator_handle
          ? resolveOrchestrationParty(run.coordinator_handle, db).orcaSessionId
          : null))
      : undefined
  } else if (to.startsWith('dispatch:')) {
    const dispatch = db.getDispatchContextById(to.slice(9))
    recipient =
      dispatch?.assignee_orca_session_id ??
      (dispatch?.assignee_handle
        ? resolveOrchestrationParty(dispatch.assignee_handle, db).orcaSessionId
        : null)
  } else {
    recipient = resolveOrchestrationParty(to, db).orcaSessionId
  }
  if (!recipient || !isOrcaSessionId(recipient)) {
    return
  }
  const root = canonicalOrcaSessionId(recipient)
  if (
    root !== canonicalOrcaSessionId(sender) &&
    link.participants.some((p) => p.conversationId === root)
  ) {
    throw new OrchestrationError(
      'session_link_required',
      `These chats are linked. Use orchestration link-send --id ${link.id}; ordinary mail cannot bypass link limits or pause.`
    )
  }
}
