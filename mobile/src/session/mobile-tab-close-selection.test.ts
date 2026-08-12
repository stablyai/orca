import { describe, expect, it } from 'vitest'
import { selectBulkCloseTabs } from './mobile-tab-close-selection'

const tab = (id: string, isDirty?: boolean, isPinned?: boolean) => ({
  id,
  ...(isDirty === undefined ? {} : { isDirty }),
  ...(isPinned === undefined ? {} : { isPinned })
})

describe('selectBulkCloseTabs', () => {
  const tabs = [tab('a'), tab('b'), tab('c'), tab('d')]

  it('selects every tab except the anchor for mode "others"', () => {
    expect(selectBulkCloseTabs(tabs, 'b', 'others').map((t) => t.id)).toEqual(['a', 'c', 'd'])
  })

  it('selects tabs before the anchor for mode "left"', () => {
    expect(selectBulkCloseTabs(tabs, 'c', 'left').map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('selects tabs after the anchor for mode "right"', () => {
    expect(selectBulkCloseTabs(tabs, 'b', 'right').map((t) => t.id)).toEqual(['c', 'd'])
  })

  it('returns empty when the anchor is at the edge', () => {
    expect(selectBulkCloseTabs(tabs, 'a', 'left')).toEqual([])
    expect(selectBulkCloseTabs(tabs, 'd', 'right')).toEqual([])
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
