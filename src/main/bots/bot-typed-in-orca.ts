// Whether a message in a bot's chat is one a person typed in Orca, read from Orca's own record of the
// send: never Orca's own message (a continue after a restart or a usage limit), an agent's, an
// automation's or a connector delivery's.
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'

function sentByPerson(
  item: AgentJournalRenderItem,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  const sent = submissions.find(
    (submission) =>
      agentJournalSubmissionKey(submission.clientMessageId) === item.itemId ||
      submission.providerItemId === item.itemId
  )
  // As the journal reads a personal send; Orca's continues name no sender and come from the host.
  // A queued card handed over says nothing of who queued it here, so it fails safe.
  return (
    sent !== undefined &&
    sent.queuedMessageId === undefined &&
    (sent.source?.kind === 'user' || (sent.source === undefined && sent.origin === 'client'))
  )
}

/** A person typed it in Orca: an automation's run or event, agent mail and deliveries are marked. */
export function typedInOrcaByPerson(
  item: AgentJournalRenderItem,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  const body = item.body
  return (
    body.kind === 'message' &&
    !body.from &&
    body.origin === undefined &&
    !body.asker &&
    !body.memorySource &&
    !body.automationRun &&
    // Sent by an agent through Orca (its CLI stamps it): never a person, whatever its source says.
    body.typedBy?.by !== 'agent' &&
    sentByPerson(item, submissions)
  )
}

/** The owner typed it in Orca: at the host's own window, or on a paired device the host found signed
 *  in to its own account. Anything Orca can't place as the owner (no stamp, an account it couldn't
 *  compare, another account) is not. */
export function typedInOrcaByOwner(
  item: AgentJournalRenderItem,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  const typedBy = item.body.kind === 'message' ? item.body.typedBy : undefined
  return (
    (typedBy?.by === 'host' || (typedBy?.by === 'device' && typedBy.own === true)) &&
    typedInOrcaByPerson(item, submissions)
  )
}
