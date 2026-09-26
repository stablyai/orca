import { randomUUID } from 'node:crypto'

const cursors = new Map<string, { scope: string; after: string; expiresAt: number }>()
const TTL_MS = 10 * 60 * 1000

export function readAttentionCursor(cursor: string | undefined, scope: string): string | undefined {
  if (!cursor) {
    return undefined
  }
  const saved = cursors.get(cursor)
  if (!saved || saved.expiresAt < Date.now() || saved.scope !== scope) {
    throw new Error('This page expired or its connection changed. Refresh the list.')
  }
  return saved.after
}

export function saveAttentionCursor(
  scope: string,
  pageInfo: { hasNextPage: boolean; endCursor?: string | null },
  previous?: string
): string | null {
  if (!pageInfo.hasNextPage) {
    return null
  }
  if (!pageInfo.endCursor || pageInfo.endCursor === previous) {
    throw new Error('Linear returned incomplete pagination. Refresh the list.')
  }
  for (const [id, cursor] of cursors) {
    if (cursor.expiresAt < Date.now()) {
      cursors.delete(id)
    }
  }
  while (cursors.size >= 128) {
    const oldest = cursors.keys().next().value
    if (oldest) {
      cursors.delete(oldest)
    }
  }
  const id = randomUUID()
  cursors.set(id, { scope, after: pageInfo.endCursor, expiresAt: Date.now() + TTL_MS })
  return id
}
