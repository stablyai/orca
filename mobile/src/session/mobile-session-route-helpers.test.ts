import { describe, expect, it } from 'vitest'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'

describe('isTerminalPhoneDisplayMode', () => {
  it('uses phone mode for automatic, phone, and unreported terminals', () => {
    const modes = new Map([
      ['auto', 'auto'],
      ['phone', 'phone']
    ] as const)

    expect(isTerminalPhoneDisplayMode('auto', modes)).toBe(true)
    expect(isTerminalPhoneDisplayMode('phone', modes)).toBe(true)
    expect(isTerminalPhoneDisplayMode('missing', modes)).toBe(true)
  })

  it('rejects absent handles and desktop terminals', () => {
    const modes = new Map([['desktop', 'desktop']] as const)

    expect(isTerminalPhoneDisplayMode(null, modes)).toBe(false)
    expect(isTerminalPhoneDisplayMode('desktop', modes)).toBe(false)
  })
})
