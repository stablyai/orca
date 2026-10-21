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

    expect(ordered.tabs.find((tab) => tab.id === 'a::1')).toEqual(rows[0])
    expect(ordered).toMatchObject({ activeTabId: 'a::1', activeGroupId: 'right' })
  })

  it('leaves the rows as written when main lists no group', () => {
    const write = written([terminal('a::1')])

    expect(withMainTabOrder(write, { ...MAIN, tabGroups: undefined })).toBe(write)
  })
})
