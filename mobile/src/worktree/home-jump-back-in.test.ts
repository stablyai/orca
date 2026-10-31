import { describe, expect, it } from 'vitest'
import { selectHomeAttentionWorktrees, selectHomeJumpBackInRows } from './home-jump-back-in'
import type { HomeWorktreeSummary, HostWorktreeInfo } from './home-worktree-info'

const NOW = 1_000_000_000

function row(id: string, fields: Partial<HomeWorktreeSummary>): HomeWorktreeSummary {
  return {
    worktreeId: id,
    repo: 'orca',
    branch: id,
    displayName: id,
    liveTerminalCount: 1,
    ...fields
  }
}

function info(hostId: string, rows: HomeWorktreeSummary[], provenAt = NOW): HostWorktreeInfo {
  return {
    hostId,
    totalWorktrees: rows.length,
    activeCount: 0,
    lastActiveWorktree: null,
    attention: selectHomeAttentionWorktrees(rows),
    countsProvenAt: provenAt
  }
}

describe('home jump back in', () => {
  it('puts agents waiting on the user first, then unseen finished work, then running work', () => {
    const rows = selectHomeAttentionWorktrees([
      row('running', { sidebarStatus: 'working', lastOutputAt: NOW }),
      row('finished-seen', { sidebarStatus: 'done', unread: false }),
      row('finished-unseen', { sidebarStatus: 'done', unread: true, lastOutputAt: NOW - 5 }),
      row('blocked', { sidebarStatus: 'permission', lastOutputAt: NOW - 10 }),
      row('archived', { sidebarStatus: 'permission', isArchived: true }),
      row('idle', { status: 'inactive', hasHostSidebarActivity: false })
    ])
    expect(rows.map((worktree) => worktree.worktreeId)).toEqual([
      'blocked',
      'finished-unseen',
      'running'
    ])
  })

  it('claims no agent state for a desktop that is offline or whose list has gone stale', () => {
    const blocked = [row('blocked', { sidebarStatus: 'permission' })]
    const rows = selectHomeJumpBackInRows({
      hosts: [{ id: 'live' }, { id: 'offline' }, { id: 'stale' }],
      hostStates: { live: 'connected', offline: 'disconnected', stale: 'connected' },
      worktreeInfo: {
        live: info('live', blocked),
        offline: info('offline', blocked),
        stale: info('stale', blocked, NOW - 11 * 60_000)
      },
      resumeCard: null,
      now: NOW
    })
    expect(rows.map((entry) => entry.hostId)).toEqual(['live'])
  })

  it('adds the last-opened workspace after the agents, unless it is already listed', () => {
    const resumeWorktree = row('resume', {})
    const base = {
      hosts: [{ id: 'host' }],
      hostStates: { host: 'connected' as const },
      now: NOW
    }
    const appended = selectHomeJumpBackInRows({
      ...base,
      worktreeInfo: { host: info('host', [row('blocked', { sidebarStatus: 'permission' })]) },
      resumeCard: { hostId: 'host', worktree: resumeWorktree, actionable: true }
    })
    expect(appended.map((entry) => [entry.worktree.worktreeId, entry.lastOpened])).toEqual([
      ['blocked', false],
      ['resume', true]
    ])

    const deduped = selectHomeJumpBackInRows({
      ...base,
      worktreeInfo: { host: info('host', [row('resume', { sidebarStatus: 'working' })]) },
      resumeCard: { hostId: 'host', worktree: resumeWorktree, actionable: true }
    })
    expect(deduped.map((entry) => [entry.worktree.worktreeId, entry.lastOpened])).toEqual([
      ['resume', false]
    ])
  })
})
