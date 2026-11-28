import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  isStructuredAgentSessionAsyncQuestionRow,
  newestOpenStructuredAgentSessionAsyncQuestion
} from '../../../shared/agent-session/view/structured-agent-session-async-questions'
import { projectStructuredAgentSessionMessages } from '../../../shared/agent-session/view/structured-agent-session-message-projection'
import { isDeliveredNativeChatUserMessage } from '../../../shared/native-chat/input/questions/native-chat-ask-answer'
import type { AgentSessionAwaitedQuestion } from '../../../shared/agent-session/agent-session-wire'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type { JournalStatusPosition } from './journal-status-items'

/** The shared rule over only the rows it needs: question rows newest first from their index, and
 *  the person's messages after each, until one is open or a delivered message answers the rest.
 *  Another agent's messages answer nothing, so SQL leaves them out unread. */
export function readJournalSqlOpenAsyncQuestion(
  state: JournalSqlStatusContext,
  floor: number
): AgentSessionAwaitedQuestion | undefined {
  let later: AgentJournalRenderItem[] = []
  const submissions: AgentJournalSubmission[] = []
  let before: JournalStatusPosition | undefined
  for (const candidate of state.select({ kind: 'async-question-candidates', floor })) {
    const question = state.displayed(candidate.item.itemId)
    // Skip prose rows that only mention the tool name before querying person messages after them.
    if (!question || !newestOpenStructuredAgentSessionAsyncQuestion([question], [])) {
      continue
    }
    const after = candidate.position
    // Oldest first: a question is usually answered right after it, ahead of any agent traffic.
    const segment: AgentJournalRenderItem[] = []
    for (const { item } of state.select({
      kind: 'users',
      floor,
      fromPerson: true,
      after,
      before
    })) {
      const displayed = state.displayed(item.itemId)
      if (!displayed || !isStructuredAgentSessionAsyncQuestionRow(displayed)) {
        continue
      }
      const submission = state.inputForItem(displayed.itemId)
      const [message] = projectStructuredAgentSessionMessages(
        [displayed],
        [],
        submission ? [submission] : []
      )
      if (message && isDeliveredNativeChatUserMessage(message)) {
        return undefined
      }
      segment.push(displayed)
      if (submission) {
        submissions.push(submission)
      }
    }
    later = [...segment, ...later]
    before = after
    const open = newestOpenStructuredAgentSessionAsyncQuestion([question, ...later], submissions)
    if (open) {
      return open
    }
  }
  return undefined
}
