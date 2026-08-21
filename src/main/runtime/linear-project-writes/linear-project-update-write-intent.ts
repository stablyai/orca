import type { LinearProjectUpdateHealth } from '../../../shared/linear/project-agent-access'
import { normalizeLinearLineEndings } from '../../linear/linear-text-digest'

/** Normalized intent of one append-only project update post. */
export type LinearProjectUpdateAddIntent = {
  projectId: string
  /** LF-normalized and never trimmed. */
  body: string
  /** Absent when the caller requested no health value. */
  health?: LinearProjectUpdateHealth
  /** Always explicit: the host sends `false` when `--hide-diff` is absent. */
  isDiffHidden: boolean
}

/** The subset of a stored project update that a pinned write id must match. */
export type LinearProjectUpdateIntentSnapshot = {
  projectId: string
  body: string
  health: LinearProjectUpdateHealth
  isDiffHidden: boolean
}

/**
 * A pinned write id proves a retry only when the stored post carries the same
 * intent; matching the project alone would silently accept a different post.
 */
export function projectUpdateMatchesAddIntent(
  record: LinearProjectUpdateIntentSnapshot,
  intent: LinearProjectUpdateAddIntent
): boolean {
  return (
    record.projectId === intent.projectId &&
    normalizeLinearLineEndings(record.body) === normalizeLinearLineEndings(intent.body) &&
    (intent.health === undefined || record.health === intent.health) &&
    record.isDiffHidden === intent.isDiffHidden
  )
}
