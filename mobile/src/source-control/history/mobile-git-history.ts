import { translate, type Translate } from '../../i18n/mobile-i18n'
import { formatCommitTime } from './mobile-commit-time'
import type {
  MobileGitHistoryBranchRange,
  MobileGitHistoryItem,
  MobileGitHistoryResult
} from './git-history-reply-schema'
import { refusedRpcMessageOrFallback } from '../../transport/rpc/rpc-refusal-message'
import { gitHistoryRead } from '../git/mobile-git-read-operations'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'

export const MOBILE_GIT_HISTORY_PAGE_SIZE = 50

export type MobileCommitRow = {
  id: string
  shortId: string
  subject: string
  author: string
  parentId: string | null
  relativeTime: string
}

export function toMobileCommitRow(
  item: MobileGitHistoryItem,
  nowMs: number,
  t: Translate
): MobileCommitRow {
  return {
    id: item.id,
    shortId: item.displayId ?? item.id.slice(0, 7),
    subject: item.subject || t('sourceControl.gitHistory.noCommitMessage', '(no commit message)'),
    author: item.author ?? '',
    parentId: item.parentIds[0] ?? null,
    relativeTime: formatCommitTime(item.timestamp, nowMs, t)
  }
}

export function mapMobileCommitRows(
  result: MobileGitHistoryResult,
  nowMs: number,
  t: Translate
): MobileCommitRow[] {
  return result.items.map((item) => toMobileCommitRow(item, nowMs, t))
}

export type MobileGitHistoryPageRequest = {
  // Null lists HEAD's whole history, as hosts without a base do.
  baseRef: string | null
  skip: number
}

export async function fetchMobileGitHistory(
  client: UnvalidatedRpcRequestPort,
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

function toMobileCommitListRow(
  item: MobileGitHistoryItem,
  nowMs: number,
  t: Translate
): MobileCommitListRow {
  return {
    ...toMobileCommitRow(item, nowMs, t),
    insertions: item.statistics?.insertions ?? 0,
    deletions: item.statistics?.deletions ?? 0
  }
}

export function buildMobileCommitsView(
  pages: MobileGitHistoryPages,
  nowMs: number,
  t: Translate
): MobileCommitsView {
  const { branch } = pages
  if (!branch) {
    return { kind: 'flat', rows: pages.items.map((item) => toMobileCommitListRow(item, nowMs, t)) }
  }
  const notPushed: MobileCommitListRow[] = []
  const onOrigin: MobileCommitListRow[] = []
  for (const item of pages.items) {
    ;(item.pushed === true ? onOrigin : notPushed).push(toMobileCommitListRow(item, nowMs, t))
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

export function buildMobileCommitDetail(
  item: MobileGitHistoryItem,
  t: Translate,
  intlLocale: string
): MobileCommitDetail {
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
    subject: item.subject || t('sourceControl.gitHistory.noCommitMessage', '(no commit message)'),
    body: bodyLines.join('\n').trim(),
    author:
      coAuthors.length > 0
        ? t('sourceControl.commitDetail.authorWithCoAuthors', '{{author}}, with {{coAuthors}}', {
            author,
            coAuthors: coAuthors.join(', ')
          })
        : author,
    date:
      item.timestamp == null
        ? ''
        : new Date(item.timestamp).toLocaleString(intlLocale, {
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

export function buildMobileCommitsListItems(
  view: MobileCommitsView,
  t: Translate
): MobileCommitsListItem[] {
  if (view.kind === 'flat') {
    return timelineItems(view.rows, null, false)
  }
  const items: MobileCommitsListItem[] = []
  const showBase = view.reachedBase
  if (view.notPushed.length > 0) {
    items.push({
      kind: 'section',
      key: 'not-pushed',
      title: t('sourceControl.commits.notPushed', 'Not pushed {{count}}', {
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
      title: t('sourceControl.commits.onOrigin', 'On origin {{count}}', {
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
