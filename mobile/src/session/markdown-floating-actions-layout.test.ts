import { describe, expect, it } from 'vitest'
import { resolveMarkdownFloatingActionsBottom } from './markdown-floating-actions-layout'

describe('resolveMarkdownFloatingActionsBottom', () => {
  it('keeps markdown actions at their resting bottom when the keyboard is closed', () => {
    expect(
      resolveMarkdownFloatingActionsBottom({
        keyboardLift: 0,
        restingBottom: 16,
        liftedClearance: 12
      })
    ).toBe(16)
  })

  it('raises markdown actions above the keyboard with clearance', () => {
    expect(
      resolveMarkdownFloatingActionsBottom({
        keyboardLift: 291,
        restingBottom: 16,
        liftedClearance: 12
      })
    ).toBe(303)
  })
})
