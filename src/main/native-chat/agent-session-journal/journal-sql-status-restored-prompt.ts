import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentExitPromptBody } from '../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

function first(items: Iterable<JournalStatusItem>): JournalStatusItem | undefined {
  return items[Symbol.iterator]().next().value
}

function turnOf(item: AgentJournalRenderItem): string | null {
  return item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null
}

function newestTwo(items: Iterable<JournalStatusItem>): JournalStatusItem[] {
  const found: JournalStatusItem[] = []
  for (const entry of items) {
    found.push(entry)
    if (found.length === 2) {
      break
    }
  }
  return found
}

/** The prompt an exited agent still waits on, with no send or later turn since: the same rule as
 *  restoredAgentJournalPrompt, read from three newest-row lookups instead of the transcript. */
export function readJournalSqlRestoredPrompt(
  context: Pick<JournalSqlStatusContext, 'select'>,
  floor: number
): AgentJournalRenderItem | null {
  const [prompt, previous] = newestTwo(context.select({ kind: 'latest-prompt-row', floor }))
  if (!prompt || !isAgentExitPromptBody(prompt.item.body)) {
    return null
  }
  const turnItemId = turnOf(prompt.item)
  // Two waiting in one turn (grouped questions, parallel calls) can't be told apart on resume.
  if (
    previous &&
    isAgentExitPromptBody(previous.item.body) &&
    turnOf(previous.item) === turnItemId
  ) {
    return null
  }
  const user = first(context.select({ kind: 'users', floor }))
  if (user && compareJournalStatusPositions(user.position, prompt.position) > 0) {
    return null
  }
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
