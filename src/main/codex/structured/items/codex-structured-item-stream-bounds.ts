import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { toolExecutionMetadata } from '../../../../shared/native-chat/tools/native-chat-tool-identity'
import type {
  CodexItemStreamState,
  CodexPendingItemPatch
} from './codex-structured-item-stream-contracts'
import type { CodexThreadItem } from './codex-thread-item-identity'
import type { AgentSessionDeltaSnapshot } from '../../../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { JOURNAL_RUNNING_PREVIEW_LIMITS } from '../../../native-chat/agent-session-journal/journal-payload-bounds'
import { codexItemRunState } from './codex-item-run-state'
import {
  codexRunningOutputItem,
  codexStreamingJournalItem,
  type CodexJournalItem
} from './codex-structured-item-translation'

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

export function codexOutputGrowthCheckpointDue(
  checkpointLength: number,
  textLength: number
): boolean {
  const nextLength = Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
  return !(checkpointLength > 0 && textLength < nextLength)
}

export function trimCodexPendingPatches(patches: Map<string, CodexPendingItemPatch>): number {
  let releasedBytes = 0
  while (patches.size > MAX_CODEX_ITEM_STREAM_PENDING_PATCHES) {
    const oldest = patches.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    const pending = patches.get(oldest)
    if (pending) {
      releasedBytes += pendingPatchBytes(pending)
    }
    patches.delete(oldest)
  }
  return releasedBytes
}

/** Running output rows keep only a preview, so build it without reading all the output. */
export function codexStreamingCheckpointItem(
  item: CodexThreadItem,
  stream: Pick<AgentSessionDeltaSnapshot, 'text' | 'bounded'>
): CodexJournalItem {
  const running =
    codexKeepsRunningOutputPreview(item.type) && codexItemRunState(item) === 'running'
      ? codexRunningOutputItem(item, stream.bounded(JOURNAL_RUNNING_PREVIEW_LIMITS.inlineHeadBytes))
      : null
  return running ?? codexStreamingJournalItem(item, stream.text)
}

/** Streams whose running rows store a bounded output preview keep a running digest. */
export function codexKeepsRunningOutputPreview(type: string | undefined): boolean {
  return type === 'commandExecution' || type === 'fileChange'
}
