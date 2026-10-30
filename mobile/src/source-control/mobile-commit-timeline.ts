import { detectCommitAgent } from '../../../src/shared/commit-agent-attribution'
import type { GitHistoryItem, GitHistoryItemRef } from '../../../src/shared/git-history-types'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels,
  type GitHistoryGraphNode,
  type GitHistoryItemViewModel
} from '../../../src/shared/git-history-graph'
import {
  collectGitHistoryAncestorIds,
  resolveGitHistoryUnpushedIds,
  type GitHistoryUpstreamVerdict
} from '../../../src/shared/git-history-push-state'
import { dedupeRemoteTrackingRefs } from '../../../src/shared/git-history-ref-display'
import { shortGitHash } from '../../../src/shared/git-history-log-parser'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { MobileGitHistoryResult } from './git-history-reply-schema'

const UNCOMMITTED_ID = 'mobile-timeline-uncommitted'

export type MobileTimelineCommit = {
  id: string
  shortId: string
  subject: string
  author: string
  agent: TuiAgent | null
  timestamp: number | null
  insertions: number | null
  deletions: number | null
  // Refs the timeline does not already say: not the branch, its upstream or the base.
  refs: string[]
  // Null on a detached HEAD, where there is no branch to have pushed.
  unpushed: boolean | null
}

export type MobileTimelineGroup = 'unpushed' | 'pushed'

export type MobileTimelineRow =
  | { kind: 'uncommitted'; key: string; graph: GitHistoryItemViewModel }
  | {
      kind: 'group'
      key: string
      group: MobileTimelineGroup
      count: number
      lanes: GitHistoryGraphNode[]
    }
  | { kind: 'day'; key: string; dayStartMs: number; lanes: GitHistoryGraphNode[] }
  | { kind: 'commit'; key: string; graph: GitHistoryItemViewModel; commit: MobileTimelineCommit }
  | { kind: 'base'; key: string; graph: GitHistoryItemViewModel; commit: MobileTimelineCommit }
  | { kind: 'truncated'; key: string; lanes: GitHistoryGraphNode[] }

export type MobileCommitTimelineInput = {
  result: MobileGitHistoryResult
  hasUncommittedChanges: boolean
  // Where the branch left its base, from the branch compare; null when there is no base to show.
  baseMergeBase: string | null
  // git.status's upstream verdict; it knows upstreams history's configured-tracking read misses.
  upstream: GitHistoryUpstreamVerdict | null
  startOfDay: (timestampMs: number) => number
  todayStartMs: number
}

export function toGitHistoryItem(item: MobileGitHistoryResult['items'][number]): GitHistoryItem {
  return {
    ...item,
    subject: item.subject ?? '',
    message: item.message ?? item.subject ?? '',
    timestamp: item.timestamp ?? undefined
  }
}

function informativeRefs(
  refs: readonly GitHistoryItemRef[] | undefined,
  implied: ReadonlySet<string>
): string[] {
  return dedupeRemoteTrackingRefs(refs ?? [])
    .filter((ref) => ref.category !== 'commits' && !implied.has(ref.id))
    .map((ref) => ref.name)
}

export function buildMobileCommitTimeline(input: MobileCommitTimelineInput): MobileTimelineRow[] {
  const { result } = input
  const allItems = result.items.map(toGitHistoryItem)
  // The host drops a base equal to the branch or its upstream; without one the history has no fork point.
  const baseItem =
    result.baseRef && input.baseMergeBase
      ? allItems.find((item) => item.id === input.baseMergeBase)
      : undefined
  // Topological order can list base commits above branch commits after a merge from base; cut by ancestry.
  const onBase = baseItem ? collectGitHistoryAncestorIds(allItems, baseItem.id) : new Set()
  const items = baseItem ? [...allItems.filter((item) => !onBase.has(item.id)), baseItem] : allItems
  const head = result.currentRef?.revision ?? items[0]?.id
  const withUncommitted =
    input.hasUncommittedChanges && head
      ? [{ id: UNCOMMITTED_ID, parentIds: [head], subject: '', message: '' }, ...items]
      : items
  const viewModels = buildGitHistoryViewModels(
    withUncommitted,
    buildDefaultGitHistoryColorMap(result),
    result.currentRef,
    result.remoteRef,
    result.baseRef
  )
  const unpushed = resolveGitHistoryUnpushedIds(
    { ...result, items: allItems },
    input.upstream ?? undefined
  )
  const implied = new Set(
    [result.currentRef, result.remoteRef, result.baseRef].flatMap((ref) => (ref ? [ref.id] : []))
  )

  const rows: MobileTimelineRow[] = []
  const groupRows: Extract<MobileTimelineRow, { kind: 'group' }>[] = []
  let lastDayStartMs: number | null = null
  for (const graph of viewModels) {
    const item = graph.historyItem
    if (item.id === UNCOMMITTED_ID) {
      rows.push({ kind: 'uncommitted', key: UNCOMMITTED_ID, graph })
      continue
    }
    const commit: MobileTimelineCommit = {
      id: item.id,
      shortId: item.displayId ?? shortGitHash(item.id),
      subject: item.subject,
      author: item.author ?? '',
      agent: detectCommitAgent(item),
      timestamp: item.timestamp ?? null,
      insertions: item.statistics?.insertions ?? null,
      deletions: item.statistics?.deletions ?? null,
      refs: informativeRefs(item.references, implied),
      unpushed: unpushed ? unpushed.has(item.id) : null
    }
    if (item.id === baseItem?.id) {
      rows.push({ kind: 'base', key: `base-${item.id}`, graph, commit })
      continue
    }
    if (commit.unpushed !== null) {
      const commitGroup: MobileTimelineGroup = commit.unpushed ? 'unpushed' : 'pushed'
      let groupRow = groupRows.at(-1)
      if (groupRow?.group !== commitGroup) {
        groupRow = {
          kind: 'group',
          key: `group-${commitGroup}-${item.id}`,
          group: commitGroup,
          count: 0,
          lanes: graph.inputSwimlanes
        }
        groupRows.push(groupRow)
        rows.push(groupRow)
        lastDayStartMs = null
      }
      groupRow.count += 1
    }
    if (commit.timestamp !== null) {
      const dayStartMs = input.startOfDay(commit.timestamp)
      if (dayStartMs !== lastDayStartMs && dayStartMs < input.todayStartMs) {
        rows.push({ kind: 'day', key: `day-${item.id}`, dayStartMs, lanes: graph.inputSwimlanes })
      }
      lastDayStartMs = dayStartMs
    }
    rows.push({ kind: 'commit', key: item.id, graph, commit })
  }

  if (!baseItem && result.hasMore) {
    rows.push({
      kind: 'truncated',
      key: 'truncated',
      lanes: viewModels.at(-1)?.outputSwimlanes ?? []
    })
  }
  return rows
}
