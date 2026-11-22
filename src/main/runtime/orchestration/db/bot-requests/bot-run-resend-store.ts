// A bot run that couldn't start is sent again at most once, ever: the first Send again claims the run
// here in one write, before it sends, and every later one, from any client or after a restart, is
// refused.
import type { OrchestrationDb } from '../orchestration-db'

export const BOT_RUN_RESEND_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_run_resends (
  run_id     TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

/** True for the run's first claim; false once it was ever claimed. */
export function claimBotRunResend(
  this: OrchestrationDb,
  runId: string,
  sessionId: string
): boolean {
  return (
    this.db
      .prepare('INSERT OR IGNORE INTO bot_run_resends (run_id, session_id) VALUES (?, ?)')
      .run(runId, sessionId).changes === 1
  )
}

export type BotRunResendMethods = {
  claimBotRunResend: typeof claimBotRunResend
}

export function attachBotRunResendStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { claimBotRunResend })
}
