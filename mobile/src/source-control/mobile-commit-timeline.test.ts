import { describe, expect, it } from 'vitest'
import { buildMobileCommitTimeline, type MobileTimelineRow } from './mobile-commit-timeline'
import type { MobileGitHistoryResult } from './git-history-reply-schema'

const DAY = 86_400_000
const TODAY = 20 * DAY
const startOfDay = (ms: number) => Math.floor(ms / DAY) * DAY

function commit(id: string, parents: string | string[] | null, timestamp: number) {
  return { id, parentIds: parents ? [parents].flat() : [], subject: `subject ${id}`, timestamp }
}

const currentRef = { id: 'refs/heads/feature', name: 'feature', revision: 'c4' }
const remoteRef = { id: 'refs/remotes/origin/feature', name: 'origin/feature', revision: 'c2' }
const baseRef = { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'm9' }

function describeRows(rows: MobileTimelineRow[]): string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'group':
        return `${row.group} ${row.count}`
      case 'day':
        return `day ${(TODAY - row.dayStartMs) / DAY}`
      case 'commit':
      case 'base':
        return `${row.kind} ${row.commit.id}`
      case 'uncommitted':
      case 'truncated':
        return row.kind
    }
  })
}

describe('buildMobileCommitTimeline', () => {
  const history: MobileGitHistoryResult = {
    items: [
      commit('c4', 'c3', TODAY + 5000),
      commit('c3', 'c2', TODAY + 4000),
      commit('c2', 'c1', TODAY + 3000),
      commit('c1', 'c0', TODAY - DAY + 1000),
      commit('c0', 'm0', TODAY - 3 * DAY),
      commit('m0', null, TODAY - 4 * DAY)
    ],
    currentRef,
    remoteRef,
    baseRef,
    mergeBase: 'c2',
    hasMore: true
  }

  it('lays out uncommitted work, unpushed and pushed groups, day headers, and ends at the base', () => {
    const rows = buildMobileCommitTimeline({
      result: history,
      hasUncommittedChanges: true,
      baseMergeBase: 'c0',
      upstream: null,
      startOfDay,
      todayStartMs: TODAY
    })
    expect(describeRows(rows)).toEqual([
      'uncommitted',
      'unpushed 2',
      'commit c4',
      'commit c3',
      'pushed 2',
      'commit c2',
      'day 1',
      'commit c1',
      'base c0'
    ])
    // The uncommitted node and the first commit share desktop's single lane.
    const head = rows[2]
    expect(head?.kind === 'commit' && head.graph.inputSwimlanes.map((lane) => lane.id)).toEqual([
      'c4'
    ])
  })

  it('shows the whole page and says it stops there when the host dropped the base', () => {
    const rows = buildMobileCommitTimeline({
      result: { ...history, baseRef: undefined },
      hasUncommittedChanges: false,
      baseMergeBase: 'c0',
      upstream: null,
      startOfDay,
      todayStartMs: TODAY
    })
    expect(describeRows(rows).slice(-3)).toEqual(['day 4', 'commit m0', 'truncated'])
    expect(rows.some((row) => row.kind === 'base')).toBe(false)
  })

  it('keeps branch commits that topological order lists below a base merged into the branch', () => {
    // m merges base tip b2 into the branch; git log --topo-order lists b2 before branch commit f1.
    const rows = buildMobileCommitTimeline({
      result: {
        items: [
          commit('m', ['f1', 'b2'], TODAY + 3000),
          commit('b2', 'b1', TODAY + 2000),
          commit('f1', 'b1', TODAY + 1000),
          commit('b1', null, TODAY)
        ],
        currentRef: { ...currentRef, revision: 'm' },
        baseRef
      },
      hasUncommittedChanges: false,
      baseMergeBase: 'b2',
      upstream: { hasUpstream: false, ahead: 0 },
      startOfDay,
      todayStartMs: TODAY
    })
    expect(describeRows(rows)).toEqual(['unpushed 2', 'commit m', 'commit f1', 'base b2'])
  })
})
