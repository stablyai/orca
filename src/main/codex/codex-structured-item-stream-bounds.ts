import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionDeltaWindow } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { toolExecutionMetadata } from '../../shared/native-chat-tool-identity'
import type {
  CodexItemStreamState,
  CodexPendingItemPatch
} from './codex-structured-item-stream-contracts'
import type { CodexThreadItem } from './codex-thread-item-identity'

export const MAX_CODEX_ITEM_STREAM_STATES = 256
export const MAX_CODEX_ITEM_STREAM_PENDING_PATCHES = 128
export const MAX_CODEX_ITEM_STREAM_RETAINED_BYTES = 32 * 1024 * 1024
export const MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES = 8 * 1024 * 1024
export const MAX_CODEX_ITEM_STREAM_ITEM_BYTES = 64 * 1024

export function codexToolStreamWindowDue(window: AgentSessionDeltaWindow, previous = 0): boolean {
  const length = window.replace ? window.text().length : window.baseLength + window.suffix.length
  return previous === 0 || length >= Math.max(previous + 32, Math.ceil(previous * 1.125))
}

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

export function evictCodexPendingPatches(patches: Map<string, CodexPendingItemPatch>): number {
  let removedBytes = 0
  while (patches.size > MAX_CODEX_ITEM_STREAM_PENDING_PATCHES) {
    const oldest = patches.keys().next().value
    if (oldest === undefined) {
      break
    }
    const pending = patches.get(oldest)
    if (pending) {
      removedBytes += pendingPatchBytes(pending)
    }
    patches.delete(oldest)
  }
  return removedBytes
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
