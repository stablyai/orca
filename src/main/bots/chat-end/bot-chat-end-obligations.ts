// What a bot side chat still owes, read synchronously from keyed rows of this chat alone, so the same
// check can run in the end's fence tick and again in its commit. A read that fails counts as owed.
import { isFinalAutomationRunStatus } from '../../../shared/automations/history/automation-run'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../shared/agent-session/identity/orca-session-address'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import type { BotChatEndReason } from '../../../shared/bots/bot-chat-end'

export type BotChatEndObligationSources = {
  db: OrchestrationDb
  /** The bot's automations, read from memory. */
  automations: () => readonly Pick<Automation, 'id' | 'name' | 'bot'>[]
  /** Retained runs of the named automations; final runs may be pruned, others never are. */
  runsOf: (automationIds: readonly string[]) => ReadonlyMap<string, readonly AutomationRun[]>
  /** A connector delivery is being sent to, or waits on, this session's turn. */
  deliveryPending: (sessionId: string) => boolean
}

const OPEN_REQUEST_PURPOSES = "('question', 'handoff')"

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}

function count(db: OrchestrationDb, sql: string, values: readonly string[]): number {
  const n: unknown = db.db.prepare(sql).get(...values)?.n
  return typeof n === 'number' ? n : 0
}

function exists(db: OrchestrationDb, sql: string, values: readonly string[]): boolean {
  return db.db.prepare(sql).get(...values) !== undefined
}

/** Took part in orchestration: coordinated a Run, or created or worked a Dispatch. Not endable in PR 1. */
function ranWorkers(db: OrchestrationDb, ids: readonly string[], addresses: readonly string[]) {
  const i = placeholders(ids)
  const a = placeholders(addresses)
  return (
    exists(db, `SELECT 1 FROM runs WHERE coordinator_orca_session_id IN (${i}) LIMIT 1`, ids) ||
    exists(
      db,
      `SELECT 1 FROM dispatch_contexts WHERE creator_orca_session_id IN (${i}) LIMIT 1`,
      ids
    ) ||
    exists(
      db,
      `SELECT 1 FROM dispatch_contexts WHERE assignee_orca_session_id IN (${i}) LIMIT 1`,
      ids
    ) ||
    exists(db, `SELECT 1 FROM dispatch_contexts WHERE assignee_handle IN (${a}) LIMIT 1`, addresses)
  )
}

function mailReasons(db: OrchestrationDb, ids: readonly string[]): BotChatEndReason[] {
  const addresses = ids.flatMap((id) => (isOrcaSessionId(id) ? [formatOrcaSessionAddress(id)] : []))
  const a = placeholders(addresses)
  const reasons: BotChatEndReason[] = []
  if (ranWorkers(db, ids, addresses)) {
    reasons.push({ kind: 'ran-workers' })
  }
  const unread = count(
    db,
    `SELECT COUNT(*) AS n FROM messages WHERE to_handle IN (${a}) AND read = 0`,
    addresses
  )
  if (unread > 0) {
    reasons.push({ kind: 'unread', count: unread })
  }
  const unanswered = (column: 'to_handle' | 'from_handle', extra: string) =>
    count(
      db,
      `SELECT COUNT(*) AS n FROM messages m
         JOIN bot_requests r ON r.message_id = m.id
         LEFT JOIN bot_request_outcomes o ON o.message_id = m.id
       WHERE m.${column} IN (${a}) ${extra}
         AND r.purpose IN ${OPEN_REQUEST_PURPOSES} AND o.message_id IS NULL`,
      addresses
    )
  // Unread ones are counted above; a read status asks nothing.
  const asked = unanswered('to_handle', 'AND m.read = 1')
  if (asked > 0) {
    reasons.push({ kind: 'requests', count: asked })
  }
  const waiting = unanswered('from_handle', "AND m.type <> 'heartbeat'")
  if (waiting > 0) {
    reasons.push({ kind: 'questions', count: waiting })
  }
  if (ids.some((id) => db.getStructuredMailSendMailboxesForSession(id).length > 0)) {
    reasons.push({ kind: 'replying' })
  }
  return reasons
}

function automationReasons(
  sources: BotChatEndObligationSources,
  botId: string,
  ids: readonly string[]
): BotChatEndReason[] {
  const own = sources.automations().filter((automation) => automation.bot?.botId === botId)
  const reasons: BotChatEndReason[] = own
    .filter((automation) => ids.includes(automation.bot?.chat?.sessionId ?? ''))
    .map((automation) => ({ kind: 'automation', name: automation.name }))
  const runs = sources.runsOf(own.map((automation) => automation.id))
  const going = [...runs.values()].some((list) =>
    list.some(
      (run) =>
        !isFinalAutomationRunStatus(run.status) &&
        run.chatSessionId !== null &&
        ids.includes(run.chatSessionId)
    )
  )
  return going ? [...reasons, { kind: 'automation-run' }] : reasons
}

/** Every reason the chat cannot end now; empty when it owes nothing. Throws on an unreadable source. */
export function botChatEndObligations(
  sources: BotChatEndObligationSources,
  botId: string,
  lineage: readonly string[]
): BotChatEndReason[] {
  return [
    ...mailReasons(sources.db, lineage),
    ...automationReasons(sources, botId, lineage),
    ...(lineage.some(sources.deliveryPending) ? [{ kind: 'replying' } as const] : [])
  ]
}
