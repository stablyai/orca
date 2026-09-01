export const MAX_CODEX_ITEM_STREAM_STATES = 256
export const MAX_CODEX_ITEM_STREAM_PENDING_PATCHES = 128
export const MAX_CODEX_ITEM_STREAM_RETAINED_BYTES = 32 * 1024 * 1024
export const MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES = 8 * 1024 * 1024
export const MAX_CODEX_ITEM_STREAM_ITEM_BYTES = 64 * 1024

export function codexStructuredItemKey(threadId: string, itemId: string): string {
  const key = `${encodeURIComponent(threadId)}:${encodeURIComponent(itemId)}`
  if (Buffer.byteLength(key, 'utf8') <= 1024) {
    return key
  }
  let hash = 2166136261
  for (const byte of Buffer.from(key, 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }
  return `${key.slice(0, 960)}:${(hash >>> 0).toString(16)}`
}

export function pendingPatchBytes(pending: {
  body: unknown
  blobs: readonly { payload: string }[]
}): number {
  return (
    Buffer.byteLength(JSON.stringify(pending.body), 'utf8') +
    pending.blobs.reduce((total, blob) => total + Buffer.byteLength(blob.payload, 'utf8'), 0)
  )
}

export function boundStreamItem(item: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') <= MAX_CODEX_ITEM_STREAM_ITEM_BYTES) {
    return item
  }
  return {
    type: item.type,
    id: item.id,
    ...(typeof item.command === 'string' ? { command: item.command.slice(0, 4096) } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd.slice(0, 4096) } : {}),
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {})
  }
}
