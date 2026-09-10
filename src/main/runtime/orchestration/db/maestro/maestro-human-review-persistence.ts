import {
  MaestroHumanReviewReferencesSchema,
  MaestroHumanReviewSchema,
  type MaestroHumanReview
} from '../../../../../shared/maestro-human-review'
import type { OrchestrationDb } from '../orchestration-db'

type HumanReviewRow = { references_json: string; review_json: string }

export function parseMaestroHumanReviewRow(row: HumanReviewRow): MaestroHumanReview {
  const review = MaestroHumanReviewSchema.parse(JSON.parse(row.review_json))
  const references = MaestroHumanReviewReferencesSchema.parse(JSON.parse(row.references_json))
  if (JSON.stringify(review.references) !== JSON.stringify(references)) {
    throw new Error(`Stored human review ${review.review_id} changed immutable references.`)
  }
  return review
}

export function getMaestroHumanReview(
  database: OrchestrationDb,
  reviewId: string
): MaestroHumanReview | null {
  return readOne(database, 'review_id', reviewId)
}

export function getMaestroHumanReviewByRequestId(
  database: OrchestrationDb,
  requestId: string
): MaestroHumanReview | null {
  return readOne(database, 'request_id', requestId)
}

export function readMaestroHumanReviewRows(
  database: OrchestrationDb,
  workspace: MaestroHumanReview['workspace']
): HumanReviewRow[] {
  return database.db
    .prepare(
      `SELECT references_json, review_json FROM maestro_human_reviews
       WHERE execution_host_id = ? AND workspace_key = ? AND run_id = ?
       ORDER BY updated_at DESC, review_id`
    )
    .all(workspace.execution_host_id, workspace.workspace_key, workspace.run_id) as HumanReviewRow[]
}

export function persistMaestroHumanReview(
  database: OrchestrationDb,
  review: MaestroHumanReview
): void {
  database.db
    .prepare('UPDATE maestro_human_reviews SET review_json = ?, updated_at = ? WHERE review_id = ?')
    .run(JSON.stringify(review), review.updated_at, review.review_id)
}

function readOne(
  database: OrchestrationDb,
  column: 'review_id' | 'request_id',
  value: string
): MaestroHumanReview | null {
  const row = database.db
    .prepare(`SELECT references_json, review_json FROM maestro_human_reviews WHERE ${column} = ?`)
    .get(value) as HumanReviewRow | undefined
  return row ? parseMaestroHumanReviewRow(row) : null
}
