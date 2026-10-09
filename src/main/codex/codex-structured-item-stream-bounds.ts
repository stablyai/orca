import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { toolExecutionMetadata } from '../../shared/native-chat-tool-identity'
import type { CodexItemStreamState } from './codex-structured-item-stream-contracts'
import type { CodexThreadItem } from './codex-thread-item-identity'

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

export function pendingPatchBytes(pending: { body: unknown }): number {
  return Buffer.byteLength(JSON.stringify(pending.body), 'utf8')
}

export function boundStreamItem(item: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') <= MAX_CODEX_ITEM_STREAM_ITEM_BYTES) {
    return item
  }
  return {
    type: item.type,
    id: item.id,
    ...(typeof item.source === 'string' ? { source: item.source } : {}),
    ...(typeof item.command === 'string' ? { command: item.command.slice(0, 4096) } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd.slice(0, 4096) } : {}),
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...toolExecutionMetadata(item)
  }
}

/** One item stream's retained state: the item bounded to what a checkpoint re-reads. */
export function codexItemStreamState(
  item: CodexThreadItem,
  identity: AgentJournalItemIdentity,
  startedAt?: number
): CodexItemStreamState {
  return {
    item: { ...boundStreamItem(item), type: item.type, id: item.id },
    identity,
    ...(startedAt === undefined ? {} : { startedAt })
  }
}
