import type { StructuredReplyJournalSnapshot } from '../native-chat/agent-session-wire/structured-agent-session-reply-journal'
import { openingSubmission } from '../native-chat/agent-session-journal/journal-stop-turn-end'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { latestStructuredAgentSessionTurn } from '../../shared/structured-agent-session-live-turn'

/** Uses the host's submission source and exact journal turn, including steered sends. */
export function isStructuredHumanReply(
  snapshot: StructuredReplyJournalSnapshot,
  turnId: string
): boolean {
  if (
    snapshot.items.some(
      (item) => !item.agentId && item.body.kind === 'turn' && item.body.state === 'running'
    )
  ) {
    return false
  }
  const latest = latestStructuredAgentSessionTurn(snapshot.items)
  const turn = snapshot.items.find((item) => !item.agentId && item.itemId === latest?.itemId)
  if (
    !turn ||
    turn.body.kind !== 'turn' ||
    turn.body.turnId !== turnId ||
    turn.body.state !== 'completed' ||
    turn.recovered
  ) {
    return false
  }
  const opener = openingSubmission(
    {
      aliases: snapshot.aliases,
      submissions: new Map(
        snapshot.submissions.map((submission) => [submission.clientMessageId, submission])
      )
    },
    turn.body.userItemId
  )
  return snapshot.submissions.some((submission) => {
    if (
      submission.source?.kind !== 'user' ||
      submission.dispatchState !== 'accepted' ||
      submission.recovered
    ) {
      return false
    }
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    return (
      submission === opener ||
      snapshot.items.some(
        (item) =>
          item.itemId === key &&
          item.turnScope?.kind === 'turn' &&
          item.turnScope.turnItemId === turn.itemId
      )
    )
  })
}
