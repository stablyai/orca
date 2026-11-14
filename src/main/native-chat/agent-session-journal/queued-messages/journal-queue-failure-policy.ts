import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentSessionContextClear } from '../../../../shared/agent-session/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { isStructuredAgentSessionCommandTurnId } from '../../agent-session-wire/operations/structured-agent-session-command-turn'

export function isTurnOrClear(item: AgentJournalRenderItem | undefined): boolean {
  return !!item && (!!readAgentJournalTurn(item.body) || isAgentSessionContextClear(item.body))
}

export function settledFailure(item: AgentJournalRenderItem): boolean {
  const turn = readAgentJournalTurn(item.body)
  return turn?.state !== 'running' && turn?.outcome === 'failure'
}

/** A command turn holds the queue only with an agent failure row in its turn. */
export function isCommand(item: AgentJournalRenderItem): boolean {
  const turnId = readAgentJournalTurn(item.body)?.turnId
  return !!turnId && isStructuredAgentSessionCommandTurnId(turnId)
}

/** A command's own verdict, whichever writer saved it, and a retry still under way are not the
 * agent reporting a failure. */
const NOT_REPORTS: ReadonlySet<string> = new Set([
  'compactionFailed',
  'compactionUnconfirmed',
  'commandRefused',
  'providerRetrying'
])

/** The turn a root failure row reports for, unless it is a command's own verdict: one of the kinds
 * above, or anything Orca wrote on a command's result identity (its refusals). */
export function reportedTurnItemId(item: AgentJournalRenderItem): string | null {
  const { body, turnScope } = item
  if (
    body.kind !== 'status' ||
    turnScope?.kind !== 'turn' ||
    !isRootAgentJournalItem(item) ||
    !(body.failure ? !NOT_REPORTS.has(body.failure.kind) : body.tone === 'error')
  ) {
    return null
  }
  const identity = parseAgentJournalItemKey(item.itemId)
  if (identity?.provider === 'orca' && identity.clientMessageId.startsWith('command-result:')) {
    return null
  }
  return turnScope.turnItemId
}
