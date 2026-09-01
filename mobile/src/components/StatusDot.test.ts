import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  StyleSheet: { create: <T>(styles: T) => styles },
  View: 'View'
}))

import { colors } from '../theme/mobile-theme'
import { statusDotColor } from './StatusDot'

describe('statusDotColor', () => {
  it('keeps Relay progress amber when the raw state is disconnected', () => {
    expect(statusDotColor('disconnected', { kind: 'normal', label: 'Connecting via Relay…' })).toBe(
      colors.statusAmber
    )
  })

  it('keeps an idle disconnected host gray', () => {
    expect(statusDotColor('disconnected', { kind: 'normal', label: 'Disconnected' })).toBe(
      colors.textMuted
    )
  })
})
