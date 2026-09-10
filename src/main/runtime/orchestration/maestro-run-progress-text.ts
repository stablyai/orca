import { MAESTRO_RUN_PROGRESS_TEXT_MAX_LENGTH } from '../../../shared/maestro-run-progress'

type CreatedRow = { created_at: string; id: string }

export function compareCreatedRows(left: CreatedRow, right: CreatedRow): number {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
}

export function boundedText(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  const selected = normalized || fallback
  return selected.length <= MAESTRO_RUN_PROGRESS_TEXT_MAX_LENGTH
    ? selected
    : selected.slice(0, MAESTRO_RUN_PROGRESS_TEXT_MAX_LENGTH).trimEnd()
}
