import { describe, expect, it, vi } from 'vitest'
import { selectBulkCloseTabs } from './mobile-tab-close-selection'
import {
  createBulkCloseSheetActions,
  createCloseWithBulkActions,
  describeBulkCloseConfirmation,
  runBulkCloseSessionTabs
} from './mobile-bulk-close-sheet-actions'
import type { MobileSessionTab } from './mobile-session-route-types'

const tab = (id: string, isDirty?: boolean, isPinned?: boolean) => ({
  id,
  ...(isDirty === undefined ? {} : { isDirty }),
  ...(isPinned === undefined ? {} : { isPinned })
})

describe('selectBulkCloseTabs', () => {
  const tabs = [tab('a'), tab('b'), tab('c'), tab('d')]

  it('selects every tab except the anchor', () => {
    expect(selectBulkCloseTabs(tabs, 'b').map((t) => t.id)).toEqual(['a', 'c', 'd'])
  })

  it('returns empty when the anchor is not in the list', () => {
    expect(selectBulkCloseTabs(tabs, 'missing')).toEqual([])
  })

  it('skips dirty tabs so unsaved edits survive a bulk close', () => {
    const withDirty = [tab('a', true), tab('b'), tab('c', false), tab('d')]
    expect(selectBulkCloseTabs(withDirty, 'b').map((t) => t.id)).toEqual(['c', 'd'])
  })

  it('skips pinned tabs', () => {
    const withPinned = [tab('a', undefined, true), tab('b'), tab('c', undefined, true), tab('d')]
    expect(selectBulkCloseTabs(withPinned, 'b').map((t) => t.id)).toEqual(['d'])
  })
})

describe('createBulkCloseSheetActions and confirmation', () => {
  const sessionTabs: MobileSessionTab[] = [
    { type: 'terminal', id: 'tab-1', title: 'Build', terminal: 'term-1', isActive: false },
    { type: 'terminal', id: 'tab-2', title: 'Server', terminal: 'term-2', isActive: true },
    { type: 'terminal', id: 'tab-3', title: 'Tests', terminal: 'term-3', isActive: false }
  ]

  it('keeps Close Other Tabs style and routes through confirmation', () => {
    const closeSessionTab = vi.fn(() => Promise.resolve())
    const onRequestConfirmBulkClose = vi.fn()
    const bulkActions = createBulkCloseSheetActions({
      sessionTabsRef: { current: sessionTabs },
      markdownDocs: new Map(),
      activeSessionTabIdRef: { current: 'tab-2' },
      switchSessionTab: vi.fn(),
      closeSessionTab,
      onRequestConfirmBulkClose
    })
    const closeWithBulk = createCloseWithBulkActions(closeSessionTab, bulkActions)
    const actions = closeWithBulk(sessionTabs[0], vi.fn())

    expect(actions).toHaveLength(2)
    expect(actions[0]).toMatchObject({
      label: 'Close',
      destructive: true
    })
    expect(actions[1]).toMatchObject({
      label: 'Close Other Tabs',
      destructive: true,
      closeBeforePress: true
    })

    actions[1].onPress()
    expect(closeSessionTab).not.toHaveBeenCalled()
    expect(onRequestConfirmBulkClose).toHaveBeenCalledExactlyOnceWith({
      anchor: sessionTabs[0],
      closeCount: 2,
      targetIds: ['tab-2', 'tab-3']
    })
  })

  it('switches to anchor before closing other tabs when confirmed', async () => {
    const switchSessionTab = vi.fn()
    const closedIds: string[] = []
    const closeSessionTab = vi.fn(async (target: MobileSessionTab) => {
      closedIds.push(target.id)
    })

    await runBulkCloseSessionTabs(
      {
        sessionTabsRef: { current: sessionTabs },
        markdownDocs: new Map(),
        activeSessionTabIdRef: { current: 'tab-2' },
        switchSessionTab,
        closeSessionTab
      },
      sessionTabs[0],
      ['tab-2', 'tab-3']
    )

    expect(switchSessionTab).toHaveBeenCalledExactlyOnceWith(sessionTabs[0])
    expect(closedIds).toEqual(['tab-2', 'tab-3'])
  })

  it('keeps the confirmed target set fixed when tabs open or become dirty before confirmation', async () => {
    const switchSessionTab = vi.fn()
    const closedIds: string[] = []
    const closeSessionTab = vi.fn(async (target: MobileSessionTab) => {
      closedIds.push(target.id)
    })
    const tabsAtConfirm: MobileSessionTab[] = [
      sessionTabs[0],
      {
        type: 'markdown',
        id: 'tab-2',
        title: 'Notes.md',
        filePath: '/repo/Notes.md',
        relativePath: 'Notes.md',
        documentVersion: 'v1',
        isDirty: false,
        isActive: false
      },
      sessionTabs[2],
      { type: 'terminal', id: 'tab-4', title: 'New Shell', terminal: 'term-4', isActive: true }
    ]

    await runBulkCloseSessionTabs(
      {
        sessionTabsRef: { current: tabsAtConfirm },
        markdownDocs: new Map([
          [
            'tab-2',
            {
              status: 'ready',
              content: '',
              localContent: 'unsaved draft',
              baseVersion: 'v1',
              isDirty: true,
              editable: true
            }
          ]
        ]),
        activeSessionTabIdRef: { current: 'tab-4' },
        switchSessionTab,
        closeSessionTab
      },
      sessionTabs[0],
      ['tab-2', 'tab-3']
    )

    expect(switchSessionTab).not.toHaveBeenCalled()
    expect(closedIds).toEqual(['tab-3'])
  })

  it('formats singular and plural confirmation copy with the anchor tab title', () => {
    expect(
      describeBulkCloseConfirmation({
        anchor: sessionTabs[0],
        closeCount: 1,
        targetIds: ['tab-2']
      })
    ).toEqual({
      title: 'Close 1 Other Tab?',
      message: 'Keep "Build" open and close 1 other tab?',
      confirmLabel: 'Close 1 Tab'
    })

    expect(
      describeBulkCloseConfirmation({
        anchor: sessionTabs[0],
        closeCount: 2,
        targetIds: ['tab-2', 'tab-3']
      })
    ).toEqual({
      title: 'Close 2 Other Tabs?',
      message: 'Keep "Build" open and close 2 other tabs?',
      confirmLabel: 'Close 2 Tabs'
    })
  })
})
