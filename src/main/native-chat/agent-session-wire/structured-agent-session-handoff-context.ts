import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'

/** The original send stays in the journal. Only the provider receives background context.
 * Unknown delivery counts as consumed: guessing it failed could replay instructions. */
export function withHandoffContext(
  ctx: Pick<AgentSessionHandoverContext, 'record' | 'journal'>,
  clientMessageId: string,
  body: AgentJournalMessageItem
): AgentJournalMessageItem {
  const context = ctx.record()?.providerContextBoundary?.handoff
  const floor = ctx.journal.context.floor()
  if (!context || !floor) {
    return body
  }
  const consumed = ctx.journal.submissions().some((submission) => {
    if (
      submission.clientMessageId === clientMessageId ||
      (submission.acceptedSequence ?? submission.submittedSequence ?? 0) <= floor.sequence ||
      submission.dispatchState === 'rejected' ||
      (submission.handoverRecorded && submission.handedOverAt === undefined)
    ) {
      return false
    }
    const previous = ctx.journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
    return previous?.kind === 'message' && !previous.command
  })
  if (consumed) {
    return body
  }
  const previousUser = ctx.journal
    .snapshot()
    .items.filter(
      (item) =>
        item.sequence < floor.sequence &&
        item.body.kind === 'message' &&
        item.body.role === 'user' &&
        !item.body.command &&
        !item.body.from
    )
    .sort((left, right) => right.sequence - left.sequence)[0]?.body
  return {
    ...body,
    blocks: [
      {
        type: 'text',
        text: `Background context from the previous agent session:\n${
          context
        }\nMost recent user message from the previous session (historical context):`
      },
      ...(previousUser?.kind === 'message' ? previousUser.blocks : []),
      { type: 'text', text: 'End of historical context. The current user message follows.' },
      ...body.blocks
    ]
  }
}
