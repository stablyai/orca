import {
  HTTP_URL_INPUT_PATTERN,
  parseClickUpTaskReference,
  type ClickUpTaskReference
} from '../../shared/clickup/clickup-task-reference'
import type { ClickUpTask } from '../../shared/clickup/clickup-types'

export type ClickUpSearchIntent =
  | { kind: 'reference'; reference: ClickUpTaskReference; fromUrl: boolean }
  | { kind: 'text'; text: string }

/**
 * ClickUp v2 has no full-text task search, so an id-shaped query is fetched directly and anything
 * else is matched against listed tasks. A bare token that looks like an id can still be a plain
 * word, so callers fall back to text matching when the direct fetch finds nothing.
 */
export function parseClickUpSearchIntent(input: string): ClickUpSearchIntent {
  const text = input.trim()
  const reference = parseClickUpTaskReference(text)
  return reference
    ? { kind: 'reference', reference, fromUrl: HTTP_URL_INPUT_PATTERN.test(text) }
    : { kind: 'text', text }
}

export function clickUpTaskMatchesText(task: ClickUpTask, text: string): boolean {
  const needle = text.trim().toLowerCase()
  if (!needle) {
    return true
  }
  return (
    task.name.toLowerCase().includes(needle) ||
    (task.customId?.toLowerCase().includes(needle) ?? false) ||
    task.id.toLowerCase() === needle
  )
}
