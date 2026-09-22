import type { MobileGitHistoryItem, MobileGitHistoryResult } from './git-history-reply-schema'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { gitHistoryRead } from './mobile-git-read-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

export type MobileCommitRow = {
  id: string
  shortId: string
  subject: string
  author: string
  parentId: string | null
  relativeTime: string
}

// Short relative time for a commit list (just now / Xm / Xh / Xd / Xmo / Xy).
// `timestampMs` is epoch ms, the unit GitHistoryItem.timestamp already carries.
export function formatCommitTime(timestampMs: number | null | undefined, nowMs: number): string {
  // Nullish — not falsy — so a real epoch-0 timestamp still formats.
  if (timestampMs == null) {
    return ''
  }
  const delta = nowMs - timestampMs
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return `${days}d`
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    return `${months}mo`
  }
  return `${Math.floor(months / 12)}y`
}

export function toMobileCommitRow(item: MobileGitHistoryItem, nowMs: number): MobileCommitRow {
  return {
    id: item.id,
    shortId: item.displayId ?? item.id.slice(0, 7),
    subject: item.subject || '(no commit message)',
    author: item.author ?? '',
    parentId: item.parentIds[0] ?? null,
    relativeTime: formatCommitTime(item.timestamp, nowMs)
  }
}

export function mapMobileCommitRows(
  result: MobileGitHistoryResult,
  nowMs: number
): MobileCommitRow[] {
  return result.items.map((item) => toMobileCommitRow(item, nowMs))
}

export async function fetchMobileGitHistory(
  client: RpcOperationSender,
  worktreeId: string,
  limit = 50
): Promise<MobileGitHistoryResult> {
  // Not inside the try: a transport rejection must reach the caller as the original error object.
  const reply = await gitHistoryRead.request(client, { worktree: `id:${worktreeId}`, limit })
  try {
    return gitHistoryRead.interpret(reply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Failed to load commit history'))
  }
}
