import { describe, expect, it, vi } from 'vitest'
import { createBulkCloseSheetActions } from './mobile-bulk-close-sheet-actions'
import type { MobileSessionTab, MobileSessionTabGroup } from './mobile-session-route-types'
import {
  computeSessionTabReorderPlan,
  createReorderTabSheetActions,
  resolveDraggedTabTargetIndex
} from './mobile-session-tab-reorder'

const makeTerminalTab = (id: string, parentTabId?: string): MobileSessionTab => ({
  type: 'terminal',
  id,
  ...(parentTabId ? { parentTabId } : {}),
  title: id,
  terminal: `pty-${id}`,
  isActive: id === 'tab-1'
})

describe('mobile-session-tab-reorder', () => {
  it('reorders tabs within a single tab group and generates session.tabs.move reorder payload', () => {
    const tabs: MobileSessionTab[] = [
      makeTerminalTab('tab-1'),
      makeTerminalTab('tab-2'),
      makeTerminalTab('tab-3')
    ]
    const tabGroups: MobileSessionTabGroup[] = [
      {
        id: 'group-main',
        activeTabId: 'tab-1',
        tabOrder: ['tab-1', 'tab-2', 'tab-3']
      }
    ]

    const plan = computeSessionTabReorderPlan({
      tabs,
      tabGroups,
      activeGroupId: 'group-main',
      tabId: 'tab-1',
      delta: 1
    })

    expect(plan).not.toBeNull()
    expect(plan?.reorderedTabs.map((t) => t.id)).toEqual(['tab-2', 'tab-1', 'tab-3'])
    expect(plan?.rpcMove).toEqual({
      tabId: 'tab-1',
      targetGroupId: 'group-main',
      kind: 'reorder',
      tabOrder: ['tab-2', 'tab-1', 'tab-3']
    })
  })

  it('keeps split terminal leaves grouped by parentTabId when reordering', () => {
    const tabs: MobileSessionTab[] = [
      makeTerminalTab('split-a:leaf-1', 'split-a'),
      makeTerminalTab('split-a:leaf-2', 'split-a'),
      makeTerminalTab('tab-b')
    ]
    const tabGroups: MobileSessionTabGroup[] = [
      {
        id: 'group-1',
        activeTabId: 'split-a',
        tabOrder: ['split-a', 'tab-b']
      }
    ]

    const plan = computeSessionTabReorderPlan({
      tabs,
      tabGroups,
      tabId: 'split-a:leaf-1',
      targetBlockIndex: 1
    })

    expect(plan?.reorderedTabs.map((t) => t.id)).toEqual([
      'tab-b',
      'split-a:leaf-1',
      'split-a:leaf-2'
    ])
    expect(plan?.rpcMove).toEqual({
      tabId: 'split-a',
      targetGroupId: 'group-1',
      kind: 'reorder',
      tabOrder: ['tab-b', 'split-a']
    })
  })

  it('resolves horizontal drag target index when crossing neighbor tab centers', () => {
    const tabs: MobileSessionTab[] = [
      makeTerminalTab('tab-1'),
      makeTerminalTab('tab-2'),
      makeTerminalTab('tab-3')
    ]
    const layouts = new Map([
      ['tab-1', { x: 0, width: 100 }],
      ['tab-2', { x: 108, width: 100 }],
      ['tab-3', { x: 216, width: 100 }]
    ])

    expect(
      resolveDraggedTabTargetIndex({
        draggedTabId: 'tab-1',
        dragDx: 30,
        tabs,
        layouts
      })
    ).toBeNull()

    expect(
      resolveDraggedTabTargetIndex({
        draggedTabId: 'tab-1',
        dragDx: 120,
        tabs,
        layouts
      })
    ).toBe(1)

    expect(
      resolveDraggedTabTargetIndex({
        draggedTabId: 'tab-3',
        dragDx: -120,
        tabs,
        layouts
      })
    ).toBe(1)
  })

  it('exposes Move Tab Left and Move Tab Right actions in tab action sheets', () => {
    const tabs: MobileSessionTab[] = [
      makeTerminalTab('tab-1'),
      makeTerminalTab('tab-2'),
      makeTerminalTab('tab-3')
    ]
    const onMoveByOffset = vi.fn()

    const firstTabActions = createReorderTabSheetActions({
      tabs,
      anchorTabId: 'tab-1',
      onMoveByOffset
    })
    expect(firstTabActions.map((a) => a.id)).toEqual(['moveTabRight'])

    const middleTabActions = createBulkCloseSheetActions({
      sessionTabsRef: { current: tabs },
      markdownDocs: new Map(),
      activeSessionTabIdRef: { current: 'tab-2' },
      switchSessionTab: vi.fn(),
      closeSessionTab: vi.fn(() => Promise.resolve()),
      confirmBulkClose: () => Promise.resolve(false),
      moveTabByOffset: onMoveByOffset
    })('tab-2')

    expect(middleTabActions.map((a) => a.id)).toEqual([
      'closeOtherTabs',
      'moveTabLeft',
      'moveTabRight'
    ])

    middleTabActions[1]?.onPress()
    expect(onMoveByOffset).toHaveBeenCalledWith('tab-2', -1)
  })
})
