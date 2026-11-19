import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentExitPromptBody } from '../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

function first(items: Iterable<JournalStatusItem>): JournalStatusItem | undefined {
  return items[Symbol.iterator]().next().value
}

/** The prompt an exited agent still waits on, with no send or later turn since: the same rule as
 *  restoredAgentJournalPrompt, read from three newest-row lookups instead of the transcript. */
export function readJournalSqlRestoredPrompt(
  context: Pick<JournalSqlStatusContext, 'select'>,
  floor: number
): AgentJournalRenderItem | null {
  const prompt = first(context.select({ kind: 'latest-prompt-row', floor }))
  if (!prompt || !isAgentExitPromptBody(prompt.item.body)) {
    return null
  }
  const user = first(context.select({ kind: 'users', floor, fromPerson: true }))
  if (user && compareJournalStatusPositions(user.position, prompt.position) > 0) {
    return null
  }
  const turnItemId =
    prompt.item.turnScope?.kind === 'turn' ? prompt.item.turnScope.turnItemId : null
  const turn = first(context.select({ kind: 'turns', floor, first: true }))
  if (
    turn &&
    turn.item.itemId !== turnItemId &&
    compareJournalStatusPositions(turn.position, prompt.position) > 0
  ) {
    return null
  }
  return prompt.item
}
