import { describe, expect, it } from 'vitest'
import {
  resolveMarkdownFloatingActionsBottom,
  shouldShowMarkdownFloatingActions
} from './markdown-floating-actions-layout'

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

describe('shouldShowMarkdownFloatingActions', () => {
  const idle = {
    keyboardLift: 0,
    hasStatus: false,
    showRefresh: false,
    showCopy: false,
    showSave: false
  }

  it('shows the floating row for keyboard dismissal without document actions', () => {
    expect(shouldShowMarkdownFloatingActions({ ...idle, keyboardLift: 291 })).toBe(true)
  })

  it('hides the floating row on a clean document with the keyboard closed', () => {
    expect(shouldShowMarkdownFloatingActions(idle)).toBe(false)
  })

  it.each(['hasStatus', 'showRefresh', 'showCopy', 'showSave'] as const)(
    'shows the floating row for %s alone',
    (field) => {
      expect(shouldShowMarkdownFloatingActions({ ...idle, [field]: true })).toBe(true)
    }
  )
})
