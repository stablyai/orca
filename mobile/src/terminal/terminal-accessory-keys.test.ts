import { describe, expect, it } from 'vitest'

import { TERMINAL_ACCESSORY_KEYS } from './terminal-accessory-keys'

describe('TERMINAL_ACCESSORY_KEYS', () => {
  it('sends reverse-tab with a non-repeatable Shift+Tab key', () => {
    const key = TERMINAL_ACCESSORY_KEYS.find((candidate) => candidate.label === 'Shift+Tab')

    expect(key).toEqual({
      label: 'Shift+Tab',
      bytes: '\x1b[Z',
      accessibilityLabel: 'Shift Tab'
    })
  })

  it('keeps repeat behavior explicit for built-in terminal keys', () => {
    const repeatableLabels = new Set(['⌫', 'Del', '↑', '↓', '←', '→'])

    for (const key of TERMINAL_ACCESSORY_KEYS) {
      expect(key.repeatable === true).toBe(repeatableLabels.has(key.label))
    }
  })
})
