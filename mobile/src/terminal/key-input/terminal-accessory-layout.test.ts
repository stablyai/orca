import { describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
import { normalizeTerminalAccessoryLayoutPreference } from './terminal-accessory-layout'

const KEYS_AFTER_ENTER = [
  'shiftTab',
  'space',
  'backspace',
  'delete',
  'arrowUp',
  'arrowDown',
  'arrowLeft',
  'arrowRight',
  'ctrlC',
  'ctrlD',
  'ctrlL',
  'ctrlZ',
  'ctrlR',
  'ctrlA',
  'ctrlE',
  'ctrlW',
  'ctrlU'
]

describe('normalizeTerminalAccessoryLayoutPreference', () => {
  it('places the row controls where they sat before they could be reordered', () => {
    const savedOrder = ['tab', 'escape', 'enter', ...KEYS_AFTER_ENTER]
    const layout = normalizeTerminalAccessoryLayoutPreference({
      version: 2,
      orderedBuiltInIds: savedOrder,
      visibleBuiltInIds: savedOrder.filter((id) => id !== 'enter')
    })

    expect(layout.orderedBuiltInIds).toEqual([
      'displayMode',
      'paste',
      'tab',
      'shift',
      'ctrl',
      'alt',
      'escape',
      'enter',
      ...KEYS_AFTER_ENTER
    ])
    expect(layout.visibleBuiltInIds).toEqual([
      'displayMode',
      'paste',
      'tab',
      'shift',
      'ctrl',
      'alt',
      'escape',
      ...KEYS_AFTER_ENTER
    ])
  })

  it('keeps a saved order and hidden state for the row controls', () => {
    const savedOrder = [
      'ctrl',
      'escape',
      'tab',
      'displayMode',
      'enter',
      ...KEYS_AFTER_ENTER,
      'shift',
      'alt',
      'paste'
    ]
    const layout = normalizeTerminalAccessoryLayoutPreference({
      version: 2,
      orderedBuiltInIds: savedOrder,
      visibleBuiltInIds: savedOrder.filter((id) => id !== 'paste')
    })

    expect(layout.orderedBuiltInIds).toEqual(savedOrder)
    expect(layout.visibleBuiltInIds).toEqual(savedOrder.filter((id) => id !== 'paste'))
  })
})
