import { describe, expect, it } from 'vitest'
import { selectBulkCloseTabs } from './mobile-tab-close-selection'

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
