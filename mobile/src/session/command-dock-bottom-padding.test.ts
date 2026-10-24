import { describe, expect, it } from 'vitest'
import { spacing } from '../theme/mobile-theme'
import { commandDockBottomPadding } from './command-dock-bottom-padding'

describe('commandDockBottomPadding', () => {
  it.each([
    { bottomInset: 34, keyboardLift: 0, expected: 34 + spacing.sm },
    { bottomInset: 0, keyboardLift: 0, expected: spacing.sm }
  ])(
    'lifts the resting dock above the screen corners: %j',
    ({ bottomInset, keyboardLift, expected }) => {
      expect(commandDockBottomPadding(bottomInset, keyboardLift)).toBe(expected)
    }
  )

  it.each([
    { bottomInset: 34, keyboardLift: 274, expected: 34 },
    { bottomInset: 0, keyboardLift: 308, expected: 0 }
  ])('adds no gap above an open keyboard: %j', ({ bottomInset, keyboardLift, expected }) => {
    expect(commandDockBottomPadding(bottomInset, keyboardLift)).toBe(expected)
  })
})
