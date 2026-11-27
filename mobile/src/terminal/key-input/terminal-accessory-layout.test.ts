import { describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
import { normalizeTerminalAccessoryLayoutPreference } from './terminal-accessory-layout'

describe('normalizeTerminalAccessoryLayoutPreference', () => {
  it('places the row controls where they sat before they could be reordered', () => {
    const layout = normalizeTerminalAccessoryLayoutPreference({
      version: 2,
      orderedBuiltInIds: ['tab', 'escape', 'enter'],
      visibleBuiltInIds: ['tab', 'escape']
    })

    expect(layout.orderedBuiltInIds.slice(0, 8)).toEqual([
      'displayMode',
      'paste',
      'tab',
      'shift',
      'ctrl',
      'alt',
      'escape',
      'enter'
    ])
    expect(layout.visibleBuiltInIds.slice(0, 7)).toEqual([
      'displayMode',
      'paste',
      'tab',
      'shift',
      'ctrl',
      'alt',
      'escape'
    ])
    expect(layout.visibleBuiltInIds).not.toContain('enter')
  })

  it('keeps a saved order and hidden state for the row controls', () => {
    const savedOrder = ['ctrl', 'escape', 'tab', 'displayMode', 'enter', 'shift', 'alt', 'paste']
    const layout = normalizeTerminalAccessoryLayoutPreference({
      version: 2,
      orderedBuiltInIds: savedOrder,
      visibleBuiltInIds: savedOrder.filter((id) => id !== 'paste')
    })

    expect(layout.orderedBuiltInIds.filter((id) => savedOrder.includes(id))).toEqual(savedOrder)
    expect(layout.visibleBuiltInIds).not.toContain('paste')
    expect(layout.visibleBuiltInIds).toContain('ctrl')
  })
})
