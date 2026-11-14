import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { JournalDerivedTurnScope } from './projection/journal-derived-turn-scope'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'

type Target = { sessionId: string; epoch: string }

function scope(db: Database.Database, target: Target): JournalDerivedTurnScope {
  const head = db
    .prepare(`SELECT derived_turn_item_id FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal turn scope targets a retired chat epoch')
  }
  return JournalDerivedTurnScope.restore(
    head.derived_turn_item_id === null ? null : String(head.derived_turn_item_id)
  )
}

export function readJournalDomainTurnScope(
  db: Database.Database,
  target: Target,
  body: AgentJournalItemBody
): AgentJournalTurnScope {
  return scope(db, target).scopeFor(body)
}

export function observeJournalDomainTurnScope(
  db: Database.Database,
  target: Target,
  itemId: string,
  previous: AgentJournalRenderItem | undefined,
  next: AgentJournalRenderItem | undefined
): void {
  if (
    !readAgentJournalTurn(previous?.body) &&
    !readAgentJournalTurn(next?.body) &&
    !isAgentSessionContextClear(next?.body)
  ) {
    return
  }
  const current = scope(db, target)
  const before = current.snapshot()
  current.observe(itemId, isRootAgentJournalItem(next ?? previous), previous?.body, next?.body)
  if (current.snapshot() !== before) {
    db.prepare(
      `UPDATE journal_chat_state SET derived_turn_item_id=? WHERE session_id=? AND epoch=?`
    ).run(current.snapshot(), target.sessionId, target.epoch)
  }
}
