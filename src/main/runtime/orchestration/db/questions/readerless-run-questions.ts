import type { OrchestrationDb } from '../orchestration-db'
import type { RunRow } from '../orchestration-records'
import { stampQuestionTakes } from '../messages/mail-taker'
import { runCoordinatorKey } from '../../addressing/orchestration-caller-identity'

/** A Run no one reads mail for: no coordinator, or one that is the chat `retiredChat` names. */
function readerless(run: RunRow, retiredChat?: string): boolean {
  const key = runCoordinatorKey(run)
  if (key.terminalHandle === null && key.paneKey === null) {
    return key.orcaSessionId === null || key.orcaSessionId === retiredChat
  }
  return false
}

/** Worker asks in a Run no one reads are dropped as a take, left unread so a later coordinator can
 *  still answer them; the question reconciler tells their workers. */
export function dropReaderlessRunQuestions(
  db: OrchestrationDb,
  runId: string,
  retiredChat?: string
): void {
  const run = db.getRun(runId)
  if (!run || !readerless(run, retiredChat)) {
    return
  }
  const ids = db.db
    .prepare(
      `SELECT q.message_id FROM question_threads q JOIN messages m ON m.id = q.message_id
       WHERE q.run_id = ? AND m.to_handle = ? AND m.read = 0
         AND q.status = 'pending' AND q.taken_by IS NULL`
    )
    .all(runId, `run:${runId}`)
    .flatMap(({ message_id }) => (typeof message_id === 'string' ? [message_id] : []))
  if (ids.length > 0) {
    stampQuestionTakes(db, ids, { kind: 'dropped', why: 'no-reader' })
  }
}
