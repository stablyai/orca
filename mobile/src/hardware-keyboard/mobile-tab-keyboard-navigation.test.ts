import { describe, expect, it } from 'vitest'
import type { MobileSessionTab } from '../session/mobile-session-route-types'
import {
  getIndexedKeyboardTab,
  getRelativeKeyboardTab,
  MobileRecentTabOrder
} from './mobile-tab-keyboard-navigation'

const tabs: MobileSessionTab[] = [
  { type: 'terminal', id: 't1', title: 'One', terminal: 'h1', isActive: true },
  {
    type: 'file',
    id: 'f1',
    title: 'File',
    filePath: '/tmp/a',
    relativePath: 'a',
    isDirty: false,
    isActive: false
  },
  { type: 'terminal', id: 't2', title: 'Two', terminal: 'h2', isActive: false }
]

describe('mobile tab keyboard navigation', () => {
  it('cycles all tabs and same-type tabs in visible order', () => {
    expect(getRelativeKeyboardTab({ tabs, activeTabId: 't1', direction: 1, mode: 'all' })?.id).toBe(
      'f1'
    )
    expect(
      getRelativeKeyboardTab({ tabs, activeTabId: 't1', direction: 1, mode: 'same-type' })?.id
    ).toBe('t2')
    expect(
      getRelativeKeyboardTab({ tabs, activeTabId: 't1', direction: -1, mode: 'same-type' })?.id
    ).toBe('t2')
  })

  it('jumps from a non-terminal tab to the first or last terminal', () => {
    expect(
      getRelativeKeyboardTab({ tabs, activeTabId: 'f1', direction: 1, mode: 'terminal' })?.id
    ).toBe('t1')
    expect(
      getRelativeKeyboardTab({ tabs, activeTabId: 'f1', direction: -1, mode: 'terminal' })?.id
    ).toBe('t2')
  })

  it('selects tabs by one-based index', () => {
    expect(getIndexedKeyboardTab(tabs, 2)?.id).toBe('f1')
    expect(getIndexedKeyboardTab(tabs, 4)).toBeNull()
  })

  it('tracks the previous recently used visible tab', () => {
    const recent = new MobileRecentTabOrder()
    recent.record('t1')
    recent.record('f1')
    recent.record('t2')
    expect(recent.previous('t2', new Set(['t1', 'f1', 't2']))).toBe('f1')
    recent.record('f1')
    expect(recent.previous('f1', new Set(['t1', 'f1']))).toBe('t1')
  })
})
