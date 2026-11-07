import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTerminalTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { MainSessionTabRows } from './main-session-tab-rows'
import { withMainTabOrder } from './main-session-tab-order'

const WT = 'repo::/wt'

function terminal(id: string, ptyId?: string): RuntimeMobileSessionTerminalTab {
  const [parentTabId = id, leafId = id] = id.split('::')
  return {
    type: 'terminal',
    id,
    title: id,
    parentTabId,
    leafId,
    isActive: false,
    ...(ptyId ? { ptyId } : {})
  }
}

function written(tabs: RuntimeMobileSessionTerminalTab[]): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: 'headless-hydrated:1',
    snapshotVersion: 3,
    activeGroupId: 'headless',
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'headless', activeTabId: tabs[0]?.parentTabId ?? null, tabOrder: ['a', 'b', 'c'] }
    ],
    tabs
  }
}

/** Main's layout: `c` first in one group, `a` split off in a second; main lacks `b`, holds `d`. */
const MAIN: MainSessionTabRows = {
  worktree: WT,
  activeGroupId: 'left',
  activeTabId: 'c::1',
  activeTabType: 'terminal',
  tabGroups: [
    { id: 'left', activeTabId: 'c', tabOrder: ['c', 'd'] },
    { id: 'right', activeTabId: 'a', tabOrder: ['a'] }
  ],
  tabGroupLayout: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', groupId: 'left' },
    second: { type: 'leaf', groupId: 'right' }
  },
  tabs: [terminal('c::1'), terminal('d::1'), terminal('a::1')]
}

describe("the row writer's order from main (layout-owner build)", () => {
  it("orders and groups the written rows as main's layout does, adding and dropping none", () => {
    const rows = [terminal('a::1', 'pty-new'), terminal('b::1'), terminal('c::1')]

    const ordered = withMainTabOrder(written(rows), MAIN)

    // `b`, in no group main holds, joins the written selection's group.
    expect(ordered.tabs.map((tab) => tab.id)).toEqual(['c::1', 'a::1', 'b::1'])
    expect(ordered.tabGroups?.map((group) => [group.id, group.tabOrder])).toEqual([
      ['left', ['c']],
      ['right', ['a', 'b']]
    ])
    expect(ordered.tabGroupLayout).toEqual(MAIN.tabGroupLayout)
  })

  it("keeps every fact a written row carries, its terminal id and the writer's selection", () => {
    const rows = [terminal('a::1', 'pty-new'), terminal('c::1')]

    const ordered = withMainTabOrder(written(rows), MAIN)

    expect(ordered.tabs.find((tab) => tab.id === 'a::1')).toMatchObject({
      id: 'a::1',
      parentTabId: 'a',
      leafId: '1',
      ptyId: 'pty-new',
      isActive: true
    })
    expect(ordered).toMatchObject({ activeTabId: 'a::1', activeGroupId: 'right' })
  })
})

it('transfers legacy selection through main topology instead of selecting the saved tab', () => {
  const input = written([terminal('a::1'), terminal('c::1')])
  delete input.tabGroups
  const ordered = withMainTabOrder(input, MAIN)
  expect(ordered.activeGroupId).toBe('right')
  expect(ordered.activeTabId).toBe('a::1')
  expect(ordered.tabs.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['a::1'])
})

it.each(['null', 'missing', 'empty'] as const)(
  'does not derive navigation from main inventory for strict grouped %s',
  (kind) => {
    const input = written([terminal('a::1'), terminal('c::1')])
    input.tabGroups![0]!.activeTabId = null
    if (kind === 'missing') {
      input.activeGroupId = 'missing'
    }
    if (kind === 'empty') {
      input.tabGroups = []
    }
    const ordered = withMainTabOrder(input, MAIN)
    expect(ordered.activeTabId).toBeNull()
    expect(ordered.activeTabType).toBeNull()
    expect(ordered.tabs.filter((tab) => tab.isActive)).toEqual([])
  }
)
