import type { OrchestrationDb } from '../orchestration-db'

const COLUMNS = [
  // Who took a question, as the read that took it named them; kept once set.
  ['bot_requests', 'taken_by', 'TEXT'],
  ['question_threads', 'taken_by', 'TEXT'],
  ['remote_owned_questions', 'taken_by', 'TEXT'],
  // 1 while the asker may still be owed a notice; written only by a build that decides it.
  ['bot_requests', 'awaiting', 'INTEGER'],
  ['question_threads', 'awaiting', 'INTEGER'],
  ['remote_owned_questions', 'awaiting', 'INTEGER'],
  // How a worker's question ended when no answer came: told unanswered, or dropped unread.
  ['question_threads', 'told', "TEXT CHECK(told IN ('unanswered', 'dropped'))"],
  // A paired worker's question has no thread here, so its row holds the whole ending.
  ['remote_owned_questions', 'ended', "TEXT CHECK(ended IN ('answered', 'unanswered', 'dropped'))"],
  // The question a worker was started to answer (`worker-start --for`).
  ['dispatch_contexts', 'for_message_id', 'TEXT']
] as const

/** Who took each agent question and whether its asker is still owed a notice, the question a worker
 *  was started for, and the questions this Orca asked a paired one. Each part is skipped when present. */
export function migrateV50(this: OrchestrationDb, current: number): void {
  if (current >= 50) {
    return
  }
  for (const [table, column, type] of COLUMNS) {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    }
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS peer_questions_out (
      message_id        TEXT PRIMARY KEY,
      conversation_id   TEXT NOT NULL,
      environment_id    TEXT NOT NULL,
      peer_fingerprint  TEXT NOT NULL,
      asker             TEXT NOT NULL,
      thread_id         TEXT,
      awaiting          INTEGER,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bot_requests_awaiting
      ON bot_requests(taken_by) WHERE awaiting = 1;
    CREATE INDEX IF NOT EXISTS idx_question_threads_awaiting
      ON question_threads(taken_by) WHERE awaiting = 1;
    CREATE INDEX IF NOT EXISTS idx_dispatch_contexts_for_message
      ON dispatch_contexts(for_message_id) WHERE for_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_peer_questions_out_awaiting
      ON peer_questions_out(peer_fingerprint) WHERE awaiting = 1;
    CREATE INDEX IF NOT EXISTS idx_remote_owned_questions_awaiting
      ON remote_owned_questions(taken_by) WHERE awaiting = 1;
  `)
}
