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

/** The owner typed it in Orca: a person did, and not someone signed in to another account on a
 *  paired computer. */
export function typedInOrcaByOwner(
  item: AgentJournalRenderItem,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return (
    typedInOrcaByPerson(item, submissions) &&
    item.body.kind === 'message' &&
    !(item.body.typedBy?.by === 'device' && item.body.typedBy.own === false)
  )
}
