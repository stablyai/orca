import { translate } from '../i18n/mobile-i18n'
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

export function formatCommitTime(timestampMs: number | null | undefined, nowMs: number): string {
  // Epoch zero is valid; test nullishness instead of truthiness.
  if (timestampMs == null) {
    return ''
  }
  const delta = nowMs - timestampMs
  if (delta < 60_000) {
    return translate('sourceControl.gitHistory.justNow', 'just now')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    const count = minutes
    return count === 1
      ? translate('sourceControl.gitHistory.minutes_one', '{{count}}m', { count })
      : translate('sourceControl.gitHistory.minutes_other', '{{count}}m', { count })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const count = hours
    return count === 1
      ? translate('sourceControl.gitHistory.hours_one', '{{count}}h', { count })
      : translate('sourceControl.gitHistory.hours_other', '{{count}}h', { count })
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    const count = days
    return count === 1
      ? translate('sourceControl.gitHistory.days_one', '{{count}}d', { count })
      : translate('sourceControl.gitHistory.days_other', '{{count}}d', { count })
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    const count = months
    return count === 1
      ? translate('sourceControl.gitHistory.months_one', '{{count}}mo', { count })
      : translate('sourceControl.gitHistory.months_other', '{{count}}mo', { count })
  }
  const count = Math.floor(months / 12)
  return count === 1
    ? translate('sourceControl.gitHistory.years_one', '{{count}}y', { count })
    : translate('sourceControl.gitHistory.years_other', '{{count}}y', { count })
}

export function toMobileCommitRow(item: MobileGitHistoryItem, nowMs: number): MobileCommitRow {
  return {
    id: item.id,
    shortId: item.displayId ?? item.id.slice(0, 7),
    subject:
      item.subject || translate('sourceControl.gitHistory.noCommitMessage', '(no commit message)'),
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
  // Transport rejection must escape as its original error object.
  const reply = await gitHistoryRead.request(client, { worktree: `id:${worktreeId}`, limit })
  try {
    return gitHistoryRead.interpret(reply)
  } catch (error) {
    throw new Error(
      refusedRpcMessageOrFallback(
        error,
        translate('sourceControl.gitHistory.loadFailed', 'Failed to load commit history')
      )
    )
  }
}
