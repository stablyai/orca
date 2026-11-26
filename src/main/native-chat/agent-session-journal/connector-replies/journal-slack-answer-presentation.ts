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
    const presentation = SlackAnswerPresentationSchema.safeParse(JSON.parse(value)).data
    return presentation?.visual ? presentation : undefined
  } catch {
    return undefined
  }
}

// Admit only against the same running root turn, within the journal writer's transaction.
export function prepareSlackAnswerPresentation(
  db: Database.Database,
  { sessionId, epoch, turnItemId }: JournalSlackAnswerTurn,
  presentation: SlackAnswerPresentation,
  now = Date.now()
): boolean {
  const prepared =
    Number(
      db
        .prepare(`INSERT INTO journal_slack_answer_presentations
    (session_id,epoch,turn_item_id,presentation_json,check_at)
    SELECT session_id,epoch,item_id,?,? FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND root=1
      AND kind IN ('turn','status') AND lifecycle_state='running'
    ON CONFLICT(session_id,epoch,turn_item_id) DO UPDATE SET
      presentation_json=excluded.presentation_json,check_at=excluded.check_at`)
        .run(JSON.stringify(presentation), now, sessionId, epoch, turnItemId).changes
    ) > 0
  if (prepared) {
    db.prepare(`UPDATE journal_items SET slack_answer_prepared=1
      WHERE session_id=? AND epoch=? AND item_id=?`).run(sessionId, epoch, turnItemId)
  }
  return prepared
}

/** A journal sweep can release finished drafts once no pending reply can still need them. */
export function pruneSlackAnswerPresentations(
  db: Database.Database,
  now: number,
  retentionMs: number
): { deleted: number; more: boolean } {
  const before = now - retentionMs
  const due = db
    .prepare(`SELECT
      p.session_id,p.epoch,p.turn_item_id,
      t.lifecycle_state IS NOT 'running'
        AND COALESCE(t.turn_completed_at,0)<=?
        AND NOT EXISTS (SELECT 1 FROM journal_connector_replies r
          JOIN journal_submission_attempts s ON s.session_id=r.session_id AND s.epoch=r.epoch
            AND s.message_id=COALESCE(r.claim_message_id,r.message_id) AND s.current=1
          WHERE r.session_id=p.session_id AND r.epoch=p.epoch AND r.outcome IS NULL
            AND (s.item_id=t.opener_item_id OR s.steer_turn_item_id=p.turn_item_id))
        AND NOT EXISTS (SELECT 1 FROM journal_connector_replies r
          WHERE r.session_id=p.session_id AND r.epoch=p.epoch AND r.turn_item_id=p.turn_item_id
            AND r.has_presentation=1 AND r.sent_at IS NULL) AS removable
    FROM journal_slack_answer_presentations p
    LEFT JOIN journal_items t ON t.session_id=p.session_id AND t.epoch=p.epoch AND t.item_id=p.turn_item_id
    WHERE p.check_at<=? ORDER BY p.check_at LIMIT 50`)
    .all(before, before)
  const remove = db.prepare(`DELETE FROM journal_slack_answer_presentations
    WHERE session_id=? AND epoch=? AND turn_item_id=?`)
  const postpone = db.prepare(`UPDATE journal_slack_answer_presentations SET check_at=?
    WHERE session_id=? AND epoch=? AND turn_item_id=?`)
  let deleted = 0
  for (const row of due) {
    const key = [row.session_id, row.epoch, row.turn_item_id] as const
    if (row.removable === 1) {
      deleted += Number(remove.run(...key).changes)
    } else {
      postpone.run(now, ...key)
    }
  }
  return { deleted, more: due.length === 50 }
}

export function journalSlackAnswerPreparation(
  db: Database.Database,
  turn: JournalSlackAnswerTurn
): SlackAnswerPresentation | null | undefined {
  const prepared = db
    .prepare(`SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?
      AND slack_answer_prepared=1`)
    .get(turn.sessionId, turn.epoch, turn.turnItemId)
  return prepared ? (journalSlackAnswerPresentation(db, turn) ?? null) : undefined
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
