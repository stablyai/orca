import type { GitHistoryItem, GitHistoryResult } from '../../../src/shared/git-history-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

export type MobileCommitRow = {
  id: string
  shortId: string
  subject: string
  author: string
  parentId: string | null
  relativeTime: string
}

// Short relative time for a commit list (just now / Xm / Xh / Xd / Xmo / Xy).
export function formatCommitTime(timestampSeconds: number | undefined, nowMs: number): string {
  // Nullish — not falsy — so a real epoch-0 timestamp still formats.
  if (timestampSeconds == null) {
    return ''
  }
  const delta = nowMs - timestampSeconds * 1000
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

export function toMobileCommitRow(item: GitHistoryItem, nowMs: number): MobileCommitRow {
  return {
    id: item.id,
    shortId: item.displayId ?? item.id.slice(0, 7),
    subject: item.subject || '(no commit message)',
    author: item.author ?? '',
    parentId: item.parentIds[0] ?? null,
    relativeTime: formatCommitTime(item.timestamp, nowMs)
  }
}

export function mapMobileCommitRows(result: GitHistoryResult, nowMs: number): MobileCommitRow[] {
  return result.items.map((item) => toMobileCommitRow(item, nowMs))
}

export async function fetchMobileGitHistory(
  client: Pick<RpcClient, 'sendRequest'>,
  worktreeId: string,
  limit = 50
): Promise<GitHistoryResult> {
  const response = await client.sendRequest('git.history', {
    worktree: `id:${worktreeId}`,
    limit
  })
  if (!response.ok) {
    throw new Error(response.error?.message || 'Failed to load commit history')
  }
  return (response as RpcSuccess).result as GitHistoryResult
}
