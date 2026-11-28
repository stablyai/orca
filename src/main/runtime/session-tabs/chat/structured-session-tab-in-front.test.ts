import { describe, expect, it } from 'vitest'
import { snapshotShowsTab } from './structured-session-tab-in-front'

const group = (id: string, activeTabId: string | null, tabOrder: string[]) => ({
  id,
  activeTabId,
  tabOrder
})

describe('snapshotShowsTab', () => {
  it('counts the tab its workspace shows, or one a split group shows, and no tab behind', () => {
    const one = { activeTabId: 'chat-a', tabGroups: [group('g1', 'chat-a', ['chat-a', 'chat-b'])] }
    expect(snapshotShowsTab(one, 'chat-a')).toBe(true)
    expect(snapshotShowsTab(one, 'chat-b')).toBe(false)

    // Split: the left group is focused, the right one still shows its own tab.
    const split = {
      activeTabId: 'term-1',
      tabGroups: [
        group('left', 'term-1', ['term-1', 'chat-a']),
        group('right', 'chat-b', ['chat-b'])
      ]
    }
    expect(snapshotShowsTab(split, 'chat-b')).toBe(true)
    expect(snapshotShowsTab(split, 'chat-a')).toBe(false)

    // No groups published: only the active tab is in front.
    expect(snapshotShowsTab({ activeTabId: 'chat-a' }, 'chat-a')).toBe(true)
    expect(snapshotShowsTab({ activeTabId: null }, 'chat-a')).toBe(false)
  })
})
