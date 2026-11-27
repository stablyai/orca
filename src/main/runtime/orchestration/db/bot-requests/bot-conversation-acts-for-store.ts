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

export function getBotConversationActsFor(
  this: OrchestrationDb,
  sessionId: string
): BotConversationActsFor | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema above pins both columns as TEXT.
  const row = this.db
    .prepare('SELECT acts_for, triggered_by FROM bot_conversation_acts_for WHERE session_id = ?')
    .get(sessionId) as { acts_for: string; triggered_by: string | null } | undefined
  if (!row) {
    return undefined
  }
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

export type BotConversationActsForMethods = {
  recordBotConversationActsFor: typeof recordBotConversationActsFor
  getBotConversationActsFor: typeof getBotConversationActsFor
}

export function attachBotConversationActsForStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { recordBotConversationActsFor, getBotConversationActsFor })
}
