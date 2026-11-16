import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionOutgrownChild } from '../recovery/structured-agent-session-outgrown-child'

/** Old-agent work that settles without anything the person sends. */
const SETTLES_ALONE = new Set(['turn', 'child-work', 'held-send', 'wake-up'])

/** A person's send not yet handed over waits while the old agent finishes on the account the chat
 *  is leaving; it runs once the next pass retires that agent. Mail and claimed input go on. */
export async function awaitsAccountMove(
  session: StructuredAgentSessionHostSession,
  submission: AgentJournalSubmission,
  outgrown: StructuredAgentSessionOutgrownChild
): Promise<boolean> {
  if (
    outgrown.kind !== 'deferred' ||
    !outgrown.transition ||
    !SETTLES_ALONE.has(outgrown.transition.waitsFor) ||
    !isQueuedAgentJournalSubmission(submission)
  ) {
    return false
  }
  const body = await session.journal.reads.itemBody(
    agentJournalSubmissionKey(submission.clientMessageId)
  )
  return body?.kind === 'message' && body.from === undefined
}
