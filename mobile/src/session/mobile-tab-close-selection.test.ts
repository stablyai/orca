import { describe, expect, it } from 'vitest'
import { BULK_TAB_CLOSE_ACTIONS, selectBulkCloseTabs } from './mobile-tab-close-selection'

const tab = (id: string, isDirty?: boolean, isPinned?: boolean) => ({
  id,
  ...(isDirty === undefined ? {} : { isDirty }),
  ...(isPinned === undefined ? {} : { isPinned })
})

describe('selectBulkCloseTabs', () => {
  const tabs = [tab('a'), tab('b'), tab('c'), tab('d')]

  it('offers only close-others and close-left actions', () => {
    expect(BULK_TAB_CLOSE_ACTIONS).toEqual([
      { mode: 'others', label: 'Close Other Tabs' },
      { mode: 'left', label: 'Close Tabs to the Left' }
    ])
  })

  it('selects every tab except the anchor for mode "others"', () => {
    expect(selectBulkCloseTabs(tabs, 'b', 'others').map((t) => t.id)).toEqual(['a', 'c', 'd'])
  })

  it('selects tabs before the anchor for mode "left"', () => {
    expect(selectBulkCloseTabs(tabs, 'c', 'left').map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('returns empty when the anchor is at the left edge', () => {
    expect(selectBulkCloseTabs(tabs, 'a', 'left')).toEqual([])
  })

  it('returns empty when the anchor is not in the list', () => {
    expect(selectBulkCloseTabs(tabs, 'missing', 'others')).toEqual([])
  })

  it('skips dirty tabs so unsaved edits survive a bulk close', () => {
    const withDirty = [tab('a', true), tab('b'), tab('c', false), tab('d')]
    expect(selectBulkCloseTabs(withDirty, 'd', 'left').map((t) => t.id)).toEqual(['b', 'c'])
    expect(selectBulkCloseTabs(withDirty, 'b', 'others').map((t) => t.id)).toEqual(['c', 'd'])
  })

  it('skips pinned tabs', () => {
    const withPinned = [tab('a', undefined, true), tab('b'), tab('c', undefined, true), tab('d')]
    expect(selectBulkCloseTabs(withPinned, 'd', 'left').map((t) => t.id)).toEqual(['b'])
    expect(selectBulkCloseTabs(withPinned, 'b', 'others').map((t) => t.id)).toEqual(['d'])
  })
})
