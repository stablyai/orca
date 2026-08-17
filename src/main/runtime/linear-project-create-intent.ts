import { normalizeLinearLineEndings } from '../linear/linear-text-digest'

/** A fully resolved create intent: every reference is already a Linear UUID. */
export type LinearProjectCreateIntent = {
  workspaceId: string
  /** Outer-trimmed and non-empty. */
  name: string
  teamIds: string[]
  /** LF-normalized and never trimmed; `''` is a meaningful requested value. */
  description?: string
  content?: string
  statusId?: string
  leadId?: string
  memberIds?: string[]
  labelIds?: string[]
  priority?: number
  startDate?: string
  targetDate?: string
  color?: string
  icon?: string
}

/**
 * The stored project a pinned write id is compared against. Every member is
 * widened so the host's internal snapshot stays assignable as it grows.
 */
export type LinearProjectCreateSnapshot = {
  name: string
  description?: string | null
  content?: string | null
  status?: { id: string } | null
  lead?: { id: string } | null
  members?: readonly { id: string }[]
  teams?: readonly { id: string }[]
  labels?: readonly { id: string }[]
  priority?: number | null
  startDate?: string | null
  targetDate?: string | null
  color?: string | null
  icon?: string | null
}

/**
 * A pinned write id proves a retry only when the existing project carries the
 * same intent. Unspecified create fields are never compared, because Linear may
 * apply workspace defaults the caller never asked for.
 */
export function projectMatchesCreateIntent(
  snapshot: LinearProjectCreateSnapshot,
  intent: LinearProjectCreateIntent
): boolean {
  return (
    snapshot.name === intent.name &&
    idSetMatches(snapshot.teams, intent.teamIds) &&
    textMatches(snapshot.description, intent.description) &&
    textMatches(snapshot.content, intent.content) &&
    refMatches(snapshot.status, intent.statusId) &&
    refMatches(snapshot.lead, intent.leadId) &&
    optionalIdSetMatches(snapshot.members, intent.memberIds) &&
    optionalIdSetMatches(snapshot.labels, intent.labelIds) &&
    scalarMatches(snapshot.priority, intent.priority) &&
    scalarMatches(snapshot.startDate, intent.startDate) &&
    scalarMatches(snapshot.targetDate, intent.targetDate) &&
    caseInsensitiveMatches(snapshot.color, intent.color) &&
    scalarMatches(snapshot.icon, intent.icon)
  )
}

function scalarMatches<T>(actual: T | null | undefined, requested: T | undefined): boolean {
  return requested === undefined || actual === requested
}

function textMatches(actual: string | null | undefined, requested: string | undefined): boolean {
  return (
    requested === undefined ||
    normalizeLinearLineEndings(actual ?? '') === normalizeLinearLineEndings(requested)
  )
}

function refMatches(actual: { id: string } | null | undefined, requested?: string): boolean {
  return requested === undefined || actual?.id === requested
}

function caseInsensitiveMatches(actual: string | null | undefined, requested?: string): boolean {
  return requested === undefined || (actual ?? '').toLowerCase() === requested.toLowerCase()
}

function idSetMatches(actual: readonly { id: string }[] | undefined, requested: string[]): boolean {
  const stored = new Set((actual ?? []).map((entity) => entity.id))
  const wanted = new Set(requested)
  return stored.size === wanted.size && [...wanted].every((id) => stored.has(id))
}

function optionalIdSetMatches(
  actual: readonly { id: string }[] | undefined,
  requested?: string[]
): boolean {
  return requested === undefined || idSetMatches(actual, requested)
}
