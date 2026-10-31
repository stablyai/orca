import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { replaceSessionTabInSnapshot } from './session-tab-replace'

const snapshot: RuntimeMobileSessionTabsSnapshot = {
  worktree: 'ws',
  publicationEpoch: 'e1',
  snapshotVersion: 3,
  activeGroupId: 'g1',
  activeTabId: 'agent-session:s1',
  activeTabType: 'agent-session',
  tabGroups: [
    { id: 'g1', activeTabId: 'agent-session:s1', tabOrder: ['t0', 'agent-session:s1', 't2'] }
  ],
  tabs: [
    {
      type: 'terminal',
      id: 't0::l0',
      parentTabId: 't0',
      leafId: 'l0',
      title: 'A',
      isActive: false
    },
    {
      type: 'agent-session',
      id: 'agent-session:s1',
      title: 'Chat',
      sessionId: 's1',
      agent: 'codex',
      isActive: true
    },
    { type: 'terminal', id: 't2::l2', parentTabId: 't2', leafId: 'l2', title: 'B', isActive: false }
  ]
}

describe('replaceSessionTabInSnapshot', () => {
  it('puts the terminal in the chat’s slot, drops the chat row and hints the client', () => {
    const next = replaceSessionTabInSnapshot(snapshot, {
      workspaceId: 'ws',
      replacedTabId: 'agent-session:s1',
      row: {
        type: 'terminal',
        id: 't9::l9',
        parentTabId: 't9',
        leafId: 'l9',
        title: 'C',
        isActive: false
      },
      activate: true
    })
    expect(next.tabGroups?.[0]?.tabOrder).toEqual(['t0', 't9', 't2'])
    expect(next.tabs.map((tab) => tab.id)).toEqual(['t0::l0', 't2::l2', 't9::l9'])
    expect(next.tabs.at(-1)).toMatchObject({
      replaces: { tabId: 'agent-session:s1' },
      isActive: true
    })
    expect(next).toMatchObject({
      activeTabId: 't9::l9',
      activeTabType: 'terminal',
      snapshotVersion: 4
    })
  })

  it('removes every pane row of a replaced terminal tab and appends when the slot is gone', () => {
    const withSplit = {
      ...snapshot,
      tabs: [
        ...snapshot.tabs,
        {
          type: 'terminal' as const,
          id: 't0::l1',
          parentTabId: 't0',
          leafId: 'l1',
          title: 'A2',
          isActive: false
        }
      ]
    }
    const chat = {
      type: 'agent-session' as const,
      id: 'agent-session:s2',
      title: 'Chat 2',
      sessionId: 's2',
      agent: 'codex' as const,
      isActive: false
    }
    const next = replaceSessionTabInSnapshot(withSplit, {
      workspaceId: 'ws',
      replacedTabId: 't0',
      row: chat,
      activate: false
    })
    expect(next.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === 't0')).toBe(false)
    expect(next.tabGroups?.[0]?.tabOrder).toEqual(['agent-session:s2', 'agent-session:s1', 't2'])
    const gone = replaceSessionTabInSnapshot(snapshot, {
      workspaceId: 'ws',
      replacedTabId: 'missing',
      row: chat,
      activate: false
    })
    expect(gone.tabGroups?.[0]?.tabOrder).toEqual([
      't0',
      'agent-session:s1',
      't2',
      'agent-session:s2'
    ])
    expect(gone.tabs.at(-1)).not.toHaveProperty('replaces')
  })

  it.each([
    ['still holds it', 't0::l0', true],
    ['lost it to another tab', 'agent-session:s1', false]
  ])('takes the selection only from a replaced tab that %s', (_name, held, takes) => {
    const next = replaceSessionTabInSnapshot(
      { ...snapshot, tabGroups: [{ ...snapshot.tabGroups![0]!, activeTabId: held }] },
      {
        workspaceId: 'ws',
        replacedTabId: 't0',
        row: {
          type: 'agent-session',
          id: 'agent-session:s2',
          title: 'Chat 2',
          sessionId: 's2',
          agent: 'codex',
          isActive: false
        },
        activate: true
      }
    )
    expect(next.tabs.at(-1)?.isActive).toBe(takes)
    expect(next.tabGroups?.[0]?.activeTabId).toBe(takes ? 'agent-session:s2' : held)
    expect(next.activeTabId).toBe(takes ? 'agent-session:s2' : snapshot.activeTabId)
  })
})
