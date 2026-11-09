import { describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ os: 'android' }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('../platform/host-os', () => ({ hostOs: () => host.os }))

const { reopensFocusedInputWhenKeyboardHidden } =
  await import('./terminal-live-input-keyboard-reopen')

describe('reopening a focused live input whose keyboard is hidden', () => {
  it("follows the phone's OS on the page, which runs as web", () => {
    host.os = 'android'
    expect(reopensFocusedInputWhenKeyboardHidden()).toBe(true)
    host.os = 'ios'
    expect(reopensFocusedInputWhenKeyboardHidden()).toBe(false)
  })
})
