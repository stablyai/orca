import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  isAgentExitPromptBody,
  isUnansweredAtAgentExit,
  SAME_TURN_PROMPTS_CHECKED
} from '../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import { compareJournalStatusPositions, type JournalStatusItem } from './journal-status-items'

function first(items: Iterable<JournalStatusItem>): JournalStatusItem | undefined {
  return items[Symbol.iterator]().next().value
}

function turnOf(item: AgentJournalRenderItem): string | null {
  return item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null
}

/** The newest prompt, unless another in its turn also waits on the exited agent: two can't be told
 *  apart on resume (grouped questions, parallel calls), however many answered ones lie between. */
function newestLonePrompt(items: Iterable<JournalStatusItem>): JournalStatusItem | null {
  let newest: JournalStatusItem | null = null
  let checked = 0
  for (const entry of items) {
    if (!newest) {
      if (!isAgentExitPromptBody(entry.item.body)) {
        return null
      }
      newest = entry
      continue
    }
    if (turnOf(entry.item) !== turnOf(newest.item)) {
      return newest
    }
    if (isUnansweredAtAgentExit(entry.item.body) || ++checked >= SAME_TURN_PROMPTS_CHECKED) {
      return null
    }
  }
  return newest
}

/** The prompt an exited agent still waits on, with no send or later turn since: the same rule as
 *  restoredAgentJournalPrompt, read from newest-row lookups instead of the transcript. */
export function readJournalSqlRestoredPrompt(
  context: Pick<JournalSqlStatusContext, 'select'>,
  floor: number
): AgentJournalRenderItem | null {
  const prompt = newestLonePrompt(context.select({ kind: 'latest-prompt-row', floor }))
  if (!prompt) {
    return null
  }
  const turnItemId = turnOf(prompt.item)
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
