import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
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

function agent(paneKey: string, fields: Partial<RuntimeWorktreeAgentRow>): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: NOW,
    updatedAt: NOW,
    ...fields
  }
}

function info(hostId: string, rows: HomeWorktreeSummary[]): HostWorktreeInfo {
  return {
    hostId,
    totalWorktrees: rows.length,
    activeCount: 0,
    lastActiveWorktree: null,
    attention: selectHomeAttentionWorktrees(rows),
    countsProvenAt: NOW
  }
}

describe('home jump back in', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

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

  it('claims no agent state for a desktop that is offline or whose last read failed', () => {
    const blocked = [row('blocked', { sidebarStatus: 'permission' })]
    const rows = selectHomeJumpBackInRows({
      hosts: [{ id: 'live' }, { id: 'offline' }, { id: 'failed' }],
      hostStates: { live: 'connected', offline: 'disconnected', failed: 'connected' },
      worktreeInfo: {
        live: info('live', blocked),
        offline: info('offline', blocked),
        failed: { ...info('failed', blocked), catalogUnavailable: true }
      },
      resumeCard: null
    })
    expect(rows.map((entry) => entry.hostId)).toEqual(['live'])
  })

  it('adds the last-opened workspace after the agents, unless it is already listed', () => {
    const resumeWorktree = row('resume', {})
    const base = {
      hosts: [{ id: 'host' }],
      hostStates: { host: 'connected' as const }
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

  it('names a row after the newest live top-level conversation in the dot state, else none', () => {
    vi.useFakeTimers({ now: NOW })
    const rows = selectHomeAttentionWorktrees([
      row('blocked', {
        sidebarStatus: 'permission',
        agents: [
          agent('older', {
            state: 'waiting',
            conversationName: 'Older question',
            updatedAt: NOW - 9
          }),
          agent('newer', { state: 'blocked', conversationName: 'Fix login', updatedAt: NOW - 5 }),
          agent('running', { state: 'working', conversationName: 'Refactor', updatedAt: NOW }),
          agent('worker', {
            parentPaneKey: 'running',
            state: 'waiting',
            conversationName: 'Worker',
            updatedAt: NOW
          })
        ]
      }),
      row('unnamed', {
        sidebarStatus: 'working',
        agents: [agent('a', { state: 'working' })]
      }),
      row('stale', {
        sidebarStatus: 'working',
        agents: [
          agent('s', {
            state: 'working',
            conversationName: 'Old task',
            updatedAt: NOW - 31 * 60_000
          })
        ]
      }),
      row('old-host', { sidebarStatus: 'done', unread: true })
    ])
    expect(
      rows.map((worktree) => [worktree.worktreeId, worktree.conversationName, worktree.paneKey])
    ).toEqual([
      ['blocked', 'Fix login', 'newer'],
      ['old-host', undefined, undefined],
      ['unnamed', undefined, undefined],
      ['stale', undefined, undefined]
    ])
  })
})
