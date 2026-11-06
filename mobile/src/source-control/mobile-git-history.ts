import { translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type {
  MobileGitHistoryBranchRange,
  MobileGitHistoryItem,
  MobileGitHistoryResult
} from './git-history-reply-schema'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { gitHistoryRead } from './mobile-git-read-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

export const MOBILE_GIT_HISTORY_PAGE_SIZE = 50

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

export type MobileGitHistoryPageRequest = {
  // Null lists HEAD's whole history, as hosts without a base do.
  baseRef: string | null
  skip: number
}

export async function fetchMobileGitHistory(
  client: RpcOperationSender,
  worktreeId: string,
  page?: MobileGitHistoryPageRequest
): Promise<MobileGitHistoryResult> {
  const params = page
    ? {
        worktree: `id:${worktreeId}`,
        limit: MOBILE_GIT_HISTORY_PAGE_SIZE,
        skip: page.skip,
        ...(page.baseRef ? { baseRef: page.baseRef, branchOnly: true } : {})
      }
    : { worktree: `id:${worktreeId}`, limit: MOBILE_GIT_HISTORY_PAGE_SIZE }
  // Transport rejection must escape as its original error object.
  const reply = await gitHistoryRead.request(client, params)
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

export type MobileGitHistoryPages = {
  items: MobileGitHistoryItem[]
  branch: MobileGitHistoryBranchRange | undefined
  hasMore: boolean
  // Older hosts ignore skip and would repeat page one.
  canPage: boolean
  // The host offset after the pages read so far; a HEAD that moved can repeat rows, so it is not items.length.
  nextSkip: number
}

export function appendMobileGitHistoryPage(
  previous: MobileGitHistoryPages | null,
  result: MobileGitHistoryResult
): MobileGitHistoryPages {
  const seen = new Set(previous?.items.map((item) => item.id))
  // HEAD can move between pages; drop repeats rather than show a commit twice.
  const fresh = result.items.filter((item) => !seen.has(item.id))
  const canPage = result.skip !== undefined
  return {
    items: previous ? [...previous.items, ...fresh] : result.items,
    branch: result.branch ?? previous?.branch,
    hasMore: canPage && result.hasMore === true,
    canPage,
    nextSkip: (result.skip ?? 0) + result.items.length
  }
}

export type MobileCommitListRow = MobileCommitRow & {
  insertions: number
  deletions: number
}

export type MobileCommitsView =
  | {
      kind: 'branch'
      notPushed: MobileCommitListRow[]
      onOrigin: MobileCommitListRow[]
      notPushedCount: number
      onOriginCount: number
      baseRefName: string
      // git.rebaseFromBase needs a remote base; a local main has nothing to fetch from.
      canUpdateFromBase: boolean
      behind: number
      // The base marker belongs after the last page only.
      reachedBase: boolean
    }
  | { kind: 'flat'; rows: MobileCommitListRow[] }

function toMobileCommitListRow(item: MobileGitHistoryItem, nowMs: number): MobileCommitListRow {
  return {
    ...toMobileCommitRow(item, nowMs),
    insertions: item.statistics?.insertions ?? 0,
    deletions: item.statistics?.deletions ?? 0
  }
}

export function buildMobileCommitsView(
  pages: MobileGitHistoryPages,
  nowMs: number
): MobileCommitsView {
  const { branch } = pages
  if (!branch) {
    return { kind: 'flat', rows: pages.items.map((item) => toMobileCommitListRow(item, nowMs)) }
  }
  const notPushed: MobileCommitListRow[] = []
  const onOrigin: MobileCommitListRow[] = []
  for (const item of pages.items) {
    ;(item.pushed === true ? onOrigin : notPushed).push(toMobileCommitListRow(item, nowMs))
  }
  return {
    kind: 'branch',
    notPushed,
    onOrigin,
    notPushedCount: branch.unpushed,
    onOriginCount: Math.max(0, branch.ahead - branch.unpushed),
    baseRefName: branch.baseRef.name,
    canUpdateFromBase: branch.baseRef.category === 'remote branches',
    behind: branch.behind,
    reachedBase: !pages.hasMore
  }
}

const CO_AUTHOR_TRAILER = /^co-authored-by:\s*(.+?)\s*(?:<[^>]*>)?\s*$/i

export type MobileCommitDetail = {
  subject: string
  body: string
  author: string
  date: string
}

export function buildMobileCommitDetail(item: MobileGitHistoryItem): MobileCommitDetail {
  const lines = (item.message ?? item.subject ?? '').split(/\r?\n/)
  const coAuthors: string[] = []
  const bodyLines = lines.slice(1).filter((line) => {
    const coAuthor = CO_AUTHOR_TRAILER.exec(line)?.[1]
    if (coAuthor) {
      coAuthors.push(coAuthor)
    }
    return !coAuthor
  })
  const author = item.author ?? ''
  return {
    subject:
      item.subject || translate('sourceControl.gitHistory.noCommitMessage', '(no commit message)'),
    body: bodyLines.join('\n').trim(),
    author:
      coAuthors.length > 0
        ? translate(
            'sourceControl.commitDetail.authorWithCoAuthors',
            '{{author}}, with {{coAuthors}}',
            {
              author,
              coAuthors: coAuthors.join(', ')
            }
          )
        : author,
    date:
      item.timestamp == null
        ? ''
        : new Date(item.timestamp).toLocaleString(getUiIntlLocale(), {
            dateStyle: 'medium',
            timeStyle: 'short'
          })
  }
}

export type MobileCommitsListItem =
  | { kind: 'section'; key: string; title: string; push: boolean }
  | {
      kind: 'commit'
      key: string
      row: MobileCommitListRow
      // Null when the host could not say, as on hosts without branch-only pages.
      pushed: boolean | null
      lineAbove: boolean
      lineBelow: boolean
    }
  | {
      kind: 'base'
      key: string
      baseRefName: string
      canUpdateFromBase: boolean
      behind: number
      lineAbove: boolean
    }

function timelineItems(
  rows: MobileCommitListRow[],
  pushed: boolean | null,
  continuesBelow: boolean
): MobileCommitsListItem[] {
  return rows.map((row, index) => ({
    kind: 'commit',
    key: row.id,
    row,
    pushed,
    lineAbove: index > 0,
    lineBelow: index < rows.length - 1 || continuesBelow
  }))
}

export function buildMobileCommitsListItems(view: MobileCommitsView): MobileCommitsListItem[] {
  if (view.kind === 'flat') {
    return timelineItems(view.rows, null, false)
  }
  const items: MobileCommitsListItem[] = []
  const showBase = view.reachedBase
  if (view.notPushed.length > 0) {
    items.push({
      kind: 'section',
      key: 'not-pushed',
      title: translate('sourceControl.commits.notPushed', 'Not pushed {{count}}', {
        count: view.notPushedCount
      }),
      push: true
    })
    items.push(...timelineItems(view.notPushed, false, showBase && view.onOrigin.length === 0))
  }
  if (view.onOrigin.length > 0) {
    items.push({
      kind: 'section',
      key: 'on-origin',
      title: translate('sourceControl.commits.onOrigin', 'On origin {{count}}', {
        count: view.onOriginCount
      }),
      push: false
    })
    items.push(...timelineItems(view.onOrigin, true, showBase))
  }
  if (showBase) {
    items.push({
      kind: 'base',
      key: 'base',
      baseRefName: view.baseRefName,
      canUpdateFromBase: view.canUpdateFromBase,
      behind: view.behind,
      lineAbove: items.length > 0
    })
  }
  return items
}
