import { describe, expect, it } from 'vitest'
import { buildWorktreeSnapshot, flattenWorktreeRows } from './worktree-snapshot'
import { makePsResult, makeWorktreeSummary } from './worktree-snapshot-fixtures'

describe('buildWorktreeSnapshot', () => {
  it('groups worktrees by repo, preserving first-seen order', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([
        makeWorktreeSummary({ worktreeId: 'a', repoId: 'r1', repo: 'web-app' }),
        makeWorktreeSummary({ worktreeId: 'b', repoId: 'r2', repo: 'infra' }),
        makeWorktreeSummary({ worktreeId: 'c', repoId: 'r1', repo: 'web-app' })
      ])
    )
    expect(snapshot.groups.map((g) => g.repoId)).toEqual(['r1', 'r2'])
    expect(snapshot.groups[0].worktrees.map((w) => w.worktreeId)).toEqual(['a', 'c'])
    expect(snapshot.groups[1].worktrees.map((w) => w.worktreeId)).toEqual(['b'])
  })

  it('hides dormant inactive worktrees (no agents, no live terminals)', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([
        makeWorktreeSummary({ worktreeId: 'active', status: 'active' }),
        makeWorktreeSummary({ worktreeId: 'dormant', status: 'inactive' })
      ])
    )
    expect(flattenWorktreeRows(snapshot).map((w) => w.worktreeId)).toEqual(['active'])
  })

  it('keeps an inactive worktree that still has a live terminal', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([makeWorktreeSummary({ status: 'inactive', liveTerminalCount: 1 })])
    )
    expect(flattenWorktreeRows(snapshot)).toHaveLength(1)
  })

  it('normalizes a missing agents field to an empty array (shell-only worktrees)', () => {
    // The runtime omits agents for shell-only worktrees even though the type
    // says it is always present; a missing array must not crash consumers.
    const snapshot = buildWorktreeSnapshot(
      makePsResult([makeWorktreeSummary({ agents: undefined as never })])
    )
    expect(flattenWorktreeRows(snapshot)[0].agents).toEqual([])
  })

  it('returns an empty-but-valid model for an empty worktree', () => {
    const snapshot = buildWorktreeSnapshot(makePsResult([]))
    expect(snapshot.groups).toEqual([])
    expect(snapshot.totalCount).toBe(0)
    expect(flattenWorktreeRows(snapshot)).toEqual([])
  })

  it('maps a GitHub PR badge provider-agnostically', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([makeWorktreeSummary({ linkedPR: { number: 418, state: 'open' } })])
    )
    const row = flattenWorktreeRows(snapshot)[0]
    expect(row.badges.pr).toEqual({ number: 418, state: 'open' })
    expect(row.badges.gitLabMr).toBeNull()
    expect(row.badges.linearIssue).toBeNull()
  })

  it('maps a GitLab MR badge', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([makeWorktreeSummary({ linkedGitLabMR: 22 })])
    )
    const row = flattenWorktreeRows(snapshot)[0]
    expect(row.badges.gitLabMr).toBe(22)
    expect(row.badges.pr).toBeNull()
  })

  it('maps a Linear issue badge', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([makeWorktreeSummary({ linkedLinearIssue: 'STA-335' })])
    )
    expect(flattenWorktreeRows(snapshot)[0].badges.linearIssue).toBe('STA-335')
  })

  it('carries unread and live terminal count into badges', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([makeWorktreeSummary({ unread: true, liveTerminalCount: 3 })])
    )
    const row = flattenWorktreeRows(snapshot)[0]
    expect(row.badges.unread).toBe(true)
    expect(row.badges.liveTerminalCount).toBe(3)
  })

  it('flattens rows in sidebar render order', () => {
    const snapshot = buildWorktreeSnapshot(
      makePsResult([
        makeWorktreeSummary({ worktreeId: 'a', repoId: 'r1' }),
        makeWorktreeSummary({ worktreeId: 'b', repoId: 'r2' }),
        makeWorktreeSummary({ worktreeId: 'c', repoId: 'r1' })
      ])
    )
    expect(flattenWorktreeRows(snapshot).map((w) => w.worktreeId)).toEqual(['a', 'c', 'b'])
  })
})
