import { isOrcaSessionId } from '../../../../shared/orca-session-address'
import type { OrchestrationDb } from '../db/orchestration-db'
import { currentRunCoordinatorOrcaSessionId } from '../db/runs/run-coordinator-orca-session'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import { resolveOrchestrationParty } from '../addressing/orchestration-party'
import { OrchestrationError } from '../orchestration-error'
import { SessionLinkStore } from './session-link-store'

export function assertSessionLinkMailBoundary(
  db: OrchestrationDb,
  sender: string | null | undefined,
  to: string
): void {
  if (!sender || !isOrcaSessionId(sender)) {
    return
  }
  const link = new SessionLinkStore(db).forSession(canonicalOrcaSessionId(sender))
  if (!link) {
    return
  }
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
