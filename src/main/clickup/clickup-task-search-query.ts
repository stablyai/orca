import type { ClickUpTask } from '../../shared/clickup/clickup-types'

/** A reference to one task, the way ClickUp URLs and the API name it. */
export type ClickUpTaskReference =
  | { kind: 'id'; id: string }
  | { kind: 'custom-id'; customId: string; workspaceId: string | null }

export type ClickUpSearchIntent =
  | { kind: 'reference'; reference: ClickUpTaskReference; fromUrl: boolean }
  | { kind: 'text'; text: string }

const RAW_TASK_ID_PATTERN = /^[0-9a-z]{6,12}$/
const CUSTOM_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]+-\d+$/
const WORKSPACE_ID_PATTERN = /^\d+$/
const HTTP_URL_PATTERN = /^https?:\/\//i

function referenceFromToken(
  token: string,
  workspaceId: string | null
): ClickUpTaskReference | null {
  if (CUSTOM_TASK_ID_PATTERN.test(token)) {
    return { kind: 'custom-id', customId: token.toUpperCase(), workspaceId }
  }
  return RAW_TASK_ID_PATTERN.test(token) ? { kind: 'id', id: token } : null
}

function referenceFromUrl(input: string): ClickUpTaskReference | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.hostname !== 'clickup.com' && !url.hostname.endsWith('.clickup.com')) {
    return null
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 't') {
    return null
  }
  const [first, second] = segments.slice(1)
  // /t/<workspaceId>/<customId> names the Workspace a custom id is scoped to.
  if (first && second && WORKSPACE_ID_PATTERN.test(first)) {
    return referenceFromToken(second, first)
  }
  return first ? referenceFromToken(first, null) : null
}

/** Parses a task id, custom id or task URL; returns null when the input is none of them. */
export function parseClickUpTaskReference(input: string): ClickUpTaskReference | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  return HTTP_URL_PATTERN.test(trimmed)
    ? referenceFromUrl(trimmed)
    : referenceFromToken(trimmed, null)
}

/**
 * ClickUp v2 has no full-text task search, so an id-shaped query is fetched directly and anything
 * else is matched against listed tasks. A bare token that looks like an id can still be a plain
 * word, so callers fall back to text matching when the direct fetch finds nothing.
 */
export function parseClickUpSearchIntent(input: string): ClickUpSearchIntent {
  const text = input.trim()
  const reference = parseClickUpTaskReference(text)
  return reference
    ? { kind: 'reference', reference, fromUrl: HTTP_URL_PATTERN.test(text) }
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
