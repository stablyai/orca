import { describe, expect, it } from 'vitest'
import {
  pickMobileSessionTabAfterClose,
  recordMobileSessionTabActivation,
  shouldRestoreMobileSessionTabAfterClose
} from './mobile-session-tab-recency'

const tabs = ['a', 'b', 'c'].map((id) => ({ id }))

describe('mobile session tab recency', () => {
  it('records the active tab at the most-recent end', () => {
    expect(recordMobileSessionTabActivation(['a', 'b'], tabs, 'a')).toEqual(['b', 'a'])
  })

  it('preserves a tab through a transient snapshot omission', () => {
    const duringOmission = recordMobileSessionTabActivation(['a', 'b'], [tabs[1]], 'b')
    const afterReturn = recordMobileSessionTabActivation(duringOmission, tabs, 'b')

    expect(afterReturn).toEqual(['a', 'b'])
    expect(pickMobileSessionTabAfterClose(tabs, tabs, afterReturn, 'b')?.id).toBe('a')
  })

  it('deduplicates and bounds retained history', () => {
    const ids = Array.from({ length: 150 }, (_, index) => `tab-${index}`)
    const history = recordMobileSessionTabActivation(
      ['tab-1', ...ids, 'tab-1'],
      [{ id: 'tab-149' }],
      'tab-149'
    )

    expect(history).toHaveLength(100)
    expect(history.at(-1)).toBe('tab-149')
    expect(new Set(history).size).toBe(history.length)
  })

  it('selects the previously active tab after closing the active tab', () => {
    expect(pickMobileSessionTabAfterClose(tabs, tabs, ['a', 'c', 'b'], 'b')?.id).toBe('c')
  })

  it('falls back to the right visual neighbor, then the left', () => {
    expect(pickMobileSessionTabAfterClose(tabs, tabs, ['b'], 'b')?.id).toBe('c')
    expect(pickMobileSessionTabAfterClose(tabs, tabs, ['c'], 'c')?.id).toBe('b')
  })

  it('returns null after closing the last tab', () => {
    expect(pickMobileSessionTabAfterClose([{ id: 'a' }], [], ['a'], 'a')).toBeNull()
    expect(pickMobileSessionTabAfterClose(tabs, tabs, [], 'missing')).toBeNull()
  })

  it('restores history when only a close snapshot changed the active tab', () => {
    const historyAtCloseStart = ['a', 'c', 'b']
    const historyAfterSnapshot = recordMobileSessionTabActivation(
      historyAtCloseStart,
      [tabs[0], tabs[2]],
      'a'
    )

    expect(
      pickMobileSessionTabAfterClose(tabs, [tabs[0], tabs[2]], historyAtCloseStart, 'b')?.id
    ).toBe('c')
    expect(historyAfterSnapshot).toEqual(['c', 'b', 'a'])
    expect(
      shouldRestoreMobileSessionTabAfterClose({
        closingTabId: 'b',
        activeTabIdAtCloseStart: 'b',
        selectionRevisionAtCloseStart: 3,
        currentSelectionRevision: 3
      })
    ).toBe(true)
  })

  it('uses the original order but only returns a surviving neighbor', () => {
    expect(pickMobileSessionTabAfterClose(tabs, [tabs[0], tabs[2]], ['b'], 'b')?.id).toBe('c')
    expect(pickMobileSessionTabAfterClose(tabs, [tabs[0]], ['c', 'b'], 'b')?.id).toBe('a')
  })

  it('preserves a selection made while the close request was in flight', () => {
    expect(
      shouldRestoreMobileSessionTabAfterClose({
        closingTabId: 'b',
        activeTabIdAtCloseStart: 'b',
        selectionRevisionAtCloseStart: 3,
        currentSelectionRevision: 4
      })
    ).toBe(false)
  })
})
