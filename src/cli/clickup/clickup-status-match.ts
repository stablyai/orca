import type { ClickUpStatusOption } from '../../shared/clickup/clickup-types'
import { RuntimeClientError } from '../runtime/connection/types'

/** Resolves a user-typed status to the list's exact status name; ClickUp rejects other casing. */
export function resolveClickUpStatusName(
  wanted: string,
  statuses: readonly ClickUpStatusOption[]
): string {
  const normalized = wanted.trim().toLowerCase()
  const match = statuses.find((status) => status.name.toLowerCase() === normalized)
  if (match) {
    return match.name
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `"${wanted}" is not a status of this task's list. Valid statuses: ${
      statuses.map((status) => `"${status.name}"`).join(', ') || 'none'
    }`
  )
}
