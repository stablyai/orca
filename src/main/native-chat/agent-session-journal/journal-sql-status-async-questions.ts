import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  endsStructuredAgentSessionAsyncQuestionRead,
  hasOpenStructuredAgentSessionAsyncQuestion
} from '../../../shared/agent-session/view/structured-agent-session-async-questions'
import { projectStructuredAgentSessionMessages } from '../../../shared/agent-session/view/structured-agent-session-message-projection'
import type { JournalSqlStatusContext } from './journal-sql-status-context'

/** The shared rule over only the rows it reads: user messages back to the one that ends the read,
 *  then the assistant rows after it that can carry a question. */
export function readJournalSqlAsyncQuestionOpen(
  state: JournalSqlStatusContext,
  floor: number
): boolean {
  const users: AgentJournalRenderItem[] = []
  const submissions: AgentJournalSubmission[] = []
  let after = { sequence: 0, sequenceIndex: 0, ordinal: 0 }
  for (const { item, position } of state.select({ kind: 'users', floor })) {
    const displayed = state.displayed(item.itemId)
    if (!displayed) {
      continue
    }
    const submission = state.inputForItem(item.itemId)
    users.push(displayed)
    if (submission) {
      submissions.push(submission)
    }
    const [message] = projectStructuredAgentSessionMessages(
      [displayed],
      [],
      submission ? [submission] : []
    )
    if (message && endsStructuredAgentSessionAsyncQuestionRead(message)) {
      after = position
      break
    }
  }
  const questions = [...state.select({ kind: 'async-question-candidates', after, floor })].flatMap(
    ({ item }) => state.displayed(item.itemId) ?? []
  )
  return (
    questions.length > 0 &&
    hasOpenStructuredAgentSessionAsyncQuestion([...users.toReversed(), ...questions], submissions)
  )
}
