import { beforeEach, describe, expect, it, vi } from 'vitest'

const stored = vi.hoisted((): { value: string | null } => ({ value: null }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => stored.value,
    setItem: async (_key: string, value: string) => {
      stored.value = value
    }
  }
}))

import { hostStackResetAction, rootHostSwitchAction } from '../navigation/host-stack-reset'
import {
  loadRecentWorkspaces,
  subscribeRecentWorkspaces,
  parseRecentWorkspaces,
  recordRecentWorkspace,
  RECENT_WORKSPACES_LIMIT,
  resetRecentWorkspacesForTest,
  upsertRecentWorkspace,
  type RecentWorkspace
} from '../worktree/recent-workspaces'
import { buildWorkspaceSwitcherGroups, previousRecentWorkspace } from './workspace-switcher-model'

const ws = (hostId: string, worktreeId: string, openedAt: number, name = worktreeId) => ({
  hostId,
  worktreeId,
  name,
  openedAt
})

describe('recent workspaces', () => {
  beforeEach(() => {
    stored.value = null
    resetRecentWorkspacesForTest()
  })

  it('moves a reopened workspace to the front without duplicating it', () => {
    const list = [ws('a', '1', 2), ws('b', '2', 1)]
    expect(upsertRecentWorkspace(list, ws('b', '2', 3)).map((i) => i.worktreeId)).toEqual([
      '2',
      '1'
    ])
  })

  it('keeps the last known name when the new record has none yet', () => {
    const next = upsertRecentWorkspace([ws('a', '1', 1, 'feature')], ws('a', '1', 2, ''))
    expect(next[0]?.name).toBe('feature')
  })

  it('treats the same worktree id on two hosts as two workspaces', () => {
    const next = upsertRecentWorkspace([ws('a', 'main', 1)], ws('b', 'main', 2))
    expect(next).toHaveLength(2)
  })

  it('caps the list', () => {
    let list: RecentWorkspace[] = []
    for (let i = 0; i < RECENT_WORKSPACES_LIMIT + 5; i++) {
      list = upsertRecentWorkspace(list, ws('a', String(i), i))
    }
    expect(list).toHaveLength(RECENT_WORKSPACES_LIMIT)
    expect(list[0]?.worktreeId).toBe(String(RECENT_WORKSPACES_LIMIT + 4))
  })

  it('reads malformed storage as empty and drops malformed rows', () => {
    expect(parseRecentWorkspaces('{')).toEqual([])
    expect(parseRecentWorkspaces(JSON.stringify([{ hostId: '' }, ws('a', '1', 1)]))).toEqual([
      ws('a', '1', 1)
    ])
  })

  it('persists recorded workspaces', async () => {
    await recordRecentWorkspace(ws('a', '1', 1))
    resetRecentWorkspacesForTest()
    expect(await loadRecentWorkspaces()).toEqual([ws('a', '1', 1)])
  })

  it('keeps both of two records issued before either is written', async () => {
    stored.value = JSON.stringify([ws('a', '0', 0)])
    await Promise.all([
      recordRecentWorkspace(ws('a', '1', 1)),
      recordRecentWorkspace(ws('b', '2', 2))
    ])
    const expected = [ws('b', '2', 2), ws('a', '1', 1), ws('a', '0', 0)]
    expect(await loadRecentWorkspaces()).toEqual(expected)
    expect(parseRecentWorkspaces(stored.value)).toEqual(expected)
  })

  it('keeps recording after a record fails', async () => {
    const unsubscribe = subscribeRecentWorkspaces(() => {
      throw new Error('listener failed')
    })
    await expect(recordRecentWorkspace(ws('a', '1', 1))).rejects.toThrow('listener failed')
    unsubscribe()
    await recordRecentWorkspace(ws('b', '2', 2))
    expect(await loadRecentWorkspaces()).toEqual([ws('b', '2', 2), ws('a', '1', 1)])
  })
})

describe('workspace switcher model', () => {
  const hosts = [
    { id: 'a', name: 'Machine A', lastConnected: 5 },
    { id: 'b', name: 'Machine B', lastConnected: 1 },
    { id: 'c', name: 'Machine C', lastConnected: 9 }
  ]

  it('lists every host, most recently used first, including hosts with no history', () => {
    const groups = buildWorkspaceSwitcherGroups(hosts, [ws('b', '2', 10), ws('a', '1', 5)])
    expect(groups.map((g) => g.hostId)).toEqual(['b', 'a', 'c'])
    expect(groups[2]?.workspaces).toEqual([])
  })

  it('flips to the most recent other workspace, across hosts', () => {
    const recents = [ws('a', '1', 3), ws('b', '2', 2), ws('a', '3', 1)]
    const known = new Set(['a', 'b'])
    expect(previousRecentWorkspace(recents, { hostId: 'a', worktreeId: '1' }, known)).toEqual(
      ws('b', '2', 2)
    )
  })

  it('skips workspaces on hosts that are no longer paired', () => {
    const recents = [ws('a', '1', 3), ws('gone', '2', 2)]
    expect(
      previousRecentWorkspace(recents, { hostId: 'a', worktreeId: '1' }, new Set(['a']))
    ).toBeNull()
  })
})

describe('hostStackResetAction', () => {
  it('leaves the host list under the session so one Back reaches it', () => {
    expect(hostStackResetAction('b', { worktreeId: 'w', name: 'feat' })).toEqual({
      type: 'RESET',
      payload: {
        index: 1,
        routes: [
          { name: '[hostId]/index', params: { hostId: 'b' } },
          {
            name: '[hostId]/session/[worktreeId]',
            params: { hostId: 'b', worktreeId: 'w', name: 'feat' }
          }
        ]
      }
    })
  })

  it('resets to only the host list for a host row', () => {
    expect(hostStackResetAction('b').payload.routes).toEqual([
      { name: '[hostId]/index', params: { hostId: 'b' } }
    ])
  })
})

describe('rootHostSwitchAction', () => {
  it('replaces the focused host route with one already holding the target stack', () => {
    const root = {
      index: 1,
      routes: [
        { key: 'index-1', name: 'index' },
        { key: 'h-1', name: 'h' }
      ]
    }
    expect(rootHostSwitchAction(root, 'b', { worktreeId: 'w' })).toEqual({
      type: 'RESET',
      payload: {
        index: 1,
        routes: [
          { key: 'index-1', name: 'index' },
          { name: 'h', state: hostStackResetAction('b', { worktreeId: 'w' }).payload }
        ]
      }
    })
  })

  it('drops routes above the host so Back from the host list reaches home', () => {
    const root = {
      index: 1,
      routes: [
        { key: 'index-1', name: 'index' },
        { key: 'h-1', name: 'h' },
        { key: 'settings-1', name: 'settings' }
      ]
    }
    expect(rootHostSwitchAction(root, 'b')?.payload.routes).toHaveLength(2)
  })

  it('declines when a host route is not focused', () => {
    expect(rootHostSwitchAction({ index: 0, routes: [{ name: 'index' }] }, 'b')).toBeNull()
  })
})
