// Who each bot conversation acts for, written once when it starts and never changed after: turns end,
// runs finish and Orca restarts, and the conversation still acts for the same people. Keyed by the
// conversation's /clear root, so a cleared chat keeps it.
import type {
  AutomationTriggeredBy,
  BotRequestAsker
} from '../../../../../shared/bots/bot-acts-for'
import type { OrchestrationDb } from '../orchestration-db'

export const BOT_CONVERSATION_ACTS_FOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_conversation_acts_for (
  session_id   TEXT PRIMARY KEY,
  acts_for     TEXT NOT NULL,
  triggered_by TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export type BotConversationActsFor = {
  actsFor: BotRequestAsker[]
  /** What started an automation's conversation, for the record. */
  triggeredBy?: AutomationTriggeredBy
}

/** The first record wins: a conversation's acts-for is set when it starts. */
export function recordBotConversationActsFor(
  this: OrchestrationDb,
  sessionId: string,
  record: BotConversationActsFor
): void {
  this.db
    .prepare(
      `INSERT OR IGNORE INTO bot_conversation_acts_for (session_id, acts_for, triggered_by)
       VALUES (?, ?, ?)`
    )
    .run(
      sessionId,
      JSON.stringify(record.actsFor),
      record.triggeredBy ? JSON.stringify(record.triggeredBy) : null
    )
}

type ActsForRow = { session_id: string; acts_for: string; triggered_by: string | null }

function parseActsForRow(row: ActsForRow): BotConversationActsFor {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only recordBotConversationActsFor writes these columns.
    const actsFor = JSON.parse(row.acts_for) as BotRequestAsker[]
    return {
      actsFor,
      ...(row.triggered_by
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
          { triggeredBy: JSON.parse(row.triggered_by) as AutomationTriggeredBy }
        : {})
    }
  } catch {
    // An unreadable record names no one, which no check lets through.
    return { actsFor: [{ kind: 'unknown' }] }
  }
}

export function getBotConversationActsFor(
  this: OrchestrationDb,
  sessionId: string
): BotConversationActsFor | undefined {
  return listBotConversationActsFor.call(this, [sessionId]).get(sessionId)
}

/** Many conversations' records in one read, by session id; one without a record is absent. */
export function listBotConversationActsFor(
  this: OrchestrationDb,
  sessionIds: readonly string[]
): Map<string, BotConversationActsFor> {
  if (sessionIds.length === 0) {
    return new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema above pins every column as TEXT.
  const rows = this.db
    .prepare(`SELECT session_id, acts_for, triggered_by FROM bot_conversation_acts_for
       WHERE session_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(sessionIds)) as ActsForRow[]
  return new Map(rows.map((row) => [row.session_id, parseActsForRow(row)]))
}

export type BotConversationActsForMethods = {
  recordBotConversationActsFor: typeof recordBotConversationActsFor
  getBotConversationActsFor: typeof getBotConversationActsFor
  listBotConversationActsFor: typeof listBotConversationActsFor
}

export function attachBotConversationActsForStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordBotConversationActsFor,
    getBotConversationActsFor,
    listBotConversationActsFor
  })
}
