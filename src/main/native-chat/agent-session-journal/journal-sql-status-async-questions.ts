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
import { asyncQuestionCallIds } from '../../../shared/native-chat/input/questions/native-chat-ask-replay'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import type { AgentSessionAwaitedQuestion } from '../../../shared/agent-session/agent-session-wire'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type { JournalStatusPosition } from './journal-status-items'

/** The shared rule over only the rows it needs: question rows newest first from their index, and
 *  the person's messages after each, until one is open or a delivered message answers the rest.
 *  Another agent's messages answer nothing, so SQL leaves them out unread. Replayed calls resolve
 *  against earlier question rows too, matching the chat card's whole-history read. */
export function readJournalSqlOpenAsyncQuestion(
  state: JournalSqlStatusContext,
  floor: number
): AgentSessionAwaitedQuestion | undefined {
  const candidates = [...state.select({ kind: 'async-question-candidates', floor })]
  let later: AgentJournalRenderItem[] = []
  const submissions: AgentJournalSubmission[] = []
  let before: JournalStatusPosition | undefined
  for (const [index, candidate] of candidates.entries()) {
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
    const question = state.displayed(candidate.item.itemId)
    if (!question) {
      continue
    }
    const open = newestOpenStructuredAgentSessionAsyncQuestion(
      [question, ...later],
      submissions,
      earlierAsyncQuestionRows(state, candidates, index + 1, after)
    )
    if (open) {
      return open
    }
  }
  return undefined
}

/** Earlier question rows down to the newest delivered message before the window; a copy of an
 *  answered call opens nothing, so the walk usually stops at the first earlier row. */
function earlierAsyncQuestionRows(
  state: JournalSqlStatusContext,
  candidates: readonly { item: AgentJournalRenderItem; position: JournalStatusPosition }[],
  from: number,
  after: JournalStatusPosition
): NativeChatMessage[] {
  const earlier: NativeChatMessage[] = []
  let end = after
  for (const candidate of candidates.slice(from)) {
    const displayed = state.displayed(candidate.item.itemId)
    const [message] = displayed ? projectStructuredAgentSessionMessages([displayed], [], []) : []
    if (!message) {
      continue
    }
    earlier.push(message)
    if (asyncQuestionCallIds(message).length === 0) {
      continue
    }
    for (const { item } of state.select({
      kind: 'users',
      fromPerson: true,
      after: candidate.position,
      before: end
    })) {
      const user = state.displayed(item.itemId)
      if (!user || !isStructuredAgentSessionAsyncQuestionRow(user)) {
        continue
      }
      const submission = state.inputForItem(user.itemId)
      const [delivered] = projectStructuredAgentSessionMessages(
        [user],
        [],
        submission ? [submission] : []
      )
      if (delivered && isDeliveredNativeChatUserMessage(delivered)) {
        return earlier
      }
    }
    end = candidate.position
  }
  return earlier
}
