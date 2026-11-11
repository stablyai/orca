// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const { default: Keyboard }: { default: unknown } =
    // @ts-expect-error TS7016: react-native-web ships no type declarations.
    await import('react-native-web/dist/exports/Keyboard')
  return { Keyboard, Platform: { OS: 'web' } }
})

import { startBlurringOnKeyboardClose } from './keyboard-close-blur.web'
import { publishShellKeyboardSource } from './keyboard-occlusion.web'

const { default: TextInputState }: { default: { focusTextInput: (node: HTMLElement) => void } } =
  // @ts-expect-error TS7016: react-native-web ships no type declarations.
  await import('react-native-web/dist/modules/TextInputState')

let shellHeight = 0
const shellListeners = new Set<(height: number) => void>()

function shellReports(height: number): void {
  shellHeight = height
  for (const listener of shellListeners) {
    listener(height)
  }
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36'

function focusedField(userAgent: string): HTMLInputElement {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
  const field = document.createElement('input')
  document.body.append(field)
  TextInputState.focusTextInput(field)
  return field
}

describe('a keyboard the phone closes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    publishShellKeyboardSource({
      read: () => shellHeight,
      subscribe: (listener) => {
        shellListeners.add(listener)
        return () => shellListeners.delete(listener)
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    shellListeners.clear()
    shellHeight = 0
    publishShellKeyboardSource(null)
    document.body.replaceChildren()
  })

  it("ends its field's focus on Android, so the next touch cannot raise it again", () => {
    const field = focusedField(ANDROID)
    startBlurringOnKeyboardClose()
    shellReports(300)
    expect(document.activeElement).toBe(field)

    shellReports(0)
    vi.advanceTimersByTime(1000)

    expect(document.activeElement).not.toBe(field)
  })

  it('keeps the field focused when the keyboard closes and reopens for a switch to a voice IME', () => {
    const field = focusedField(ANDROID)
    startBlurringOnKeyboardClose()
    shellReports(300)

    shellReports(0)
    vi.advanceTimersByTime(250)
    shellReports(200)
    vi.advanceTimersByTime(5000)

    expect(document.activeElement).toBe(field)
  })

  it('keeps focus and reopens the keyboard when Chromium hides it for a tapped autocorrected word', () => {
    const field = focusedField(ANDROID)
    startBlurringOnKeyboardClose()

    field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    TextInputState.focusTextInput(field)
    shellReports(300)
    const focusSessions = vi.fn()
    field.addEventListener('focus', focusSessions)
    vi.advanceTimersByTime(400)
    shellReports(0)
    vi.advanceTimersByTime(100)

    expect(document.activeElement).toBe(field)
    expect(focusSessions).toHaveBeenCalledOnce()
  })

  it.each([
    ['a touch elsewhere', 'body', 400],
    ['a Back long after a touch on the field', 'field', 5000]
  ] as const)('still ends focus on a close after %s', (_case, touched, waitMs) => {
    const field = focusedField(ANDROID)
    startBlurringOnKeyboardClose()
    shellReports(300)

    const target = touched === 'field' ? field : document.body
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    vi.advanceTimersByTime(waitMs)
    shellReports(0)
    vi.advanceTimersByTime(1000)

    expect(document.activeElement).not.toBe(field)
  })
})
