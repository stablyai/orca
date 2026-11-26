import type Database from '../../../sqlite/sync-database'
import type { JournalSlackAnswerTurn } from '../../../../shared/agent-session/journal/journal-connector-reply'
import {
  SLACK_ANSWER_MAX_BYTES,
  SlackAnswerPresentationSchema,
  type SlackAnswerPresentation
} from '../../../../shared/connectors/slack-answer-presentation'

export function readSlackAnswerPresentation(value: unknown): SlackAnswerPresentation | undefined {
  if (typeof value !== 'string' || value.length > SLACK_ANSWER_MAX_BYTES) {
    return undefined
  }
  try {
    return SlackAnswerPresentationSchema.safeParse(JSON.parse(value)).data
  } catch {
    return undefined
  }
}

// Admit only against the same running root turn, within the journal writer's transaction.
export function prepareSlackAnswerPresentation(
  db: Database.Database,
  { sessionId, epoch, turnItemId }: JournalSlackAnswerTurn,
  presentation: SlackAnswerPresentation
): boolean {
  return (
    Number(
      db
        .prepare(`INSERT INTO journal_slack_answer_presentations
    (session_id,epoch,turn_item_id,presentation_json)
    SELECT session_id,epoch,item_id,? FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND root=1
      AND kind IN ('turn','status') AND lifecycle_state='running'
    ON CONFLICT(session_id,epoch,turn_item_id) DO UPDATE SET presentation_json=excluded.presentation_json`)
        .run(JSON.stringify(presentation), sessionId, epoch, turnItemId).changes
    ) > 0
  )
}

export function journalSlackAnswerPresentation(
  db: Database.Database,
  { sessionId, epoch, turnItemId }: JournalSlackAnswerTurn
): SlackAnswerPresentation | undefined {
  return readSlackAnswerPresentation(
    db
      .prepare(`SELECT presentation_json
    FROM journal_slack_answer_presentations WHERE session_id=? AND epoch=? AND turn_item_id=?`)
      .get(sessionId, epoch, turnItemId)?.presentation_json
  )
}
