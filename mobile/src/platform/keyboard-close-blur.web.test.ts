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

function touch(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
}

function focusedField(userAgent: string): HTMLInputElement {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
  const field = document.createElement('input')
  document.body.append(field)
  TextInputState.focusTextInput(field)
  return field
}

describe('a keyboard the phone closes', () => {
  beforeEach(() => {
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
    const field = focusedField('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36')
    startBlurringOnKeyboardClose()
    shellReports(300)
    expect(document.activeElement).toBe(field)

    shellReports(0)

    expect(document.activeElement).not.toBe(field)
  })

  it('refocuses its field with the caret kept when the keyboard closes right after a touch on it, as for a suggestion menu', () => {
    vi.useFakeTimers()
    const field = focusedField('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36')
    field.value = 'reader here'
    field.setSelectionRange(3, 3)
    const setSelectionRange = vi.spyOn(field, 'setSelectionRange')
    let focusSessions = 0
    field.addEventListener('focus', () => focusSessions++)
    startBlurringOnKeyboardClose()
    shellReports(300)

    touch(field)
    shellReports(0)
    vi.advanceTimersByTime(50)

    expect(document.activeElement).toBe(field)
    expect(focusSessions).toBe(1)
    expect(setSelectionRange).toHaveBeenLastCalledWith(3, 3)
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 3])
  })

  it('still ends focus when the last touch landed outside the field', () => {
    const field = focusedField('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36')
    const terminal = document.createElement('div')
    document.body.append(terminal)
    startBlurringOnKeyboardClose()
    shellReports(300)

    touch(field)
    touch(terminal)
    shellReports(0)

    expect(document.activeElement).not.toBe(field)
  })

  it('still ends focus on a Back press long after the field was touched', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const field = focusedField('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36')
    startBlurringOnKeyboardClose()
    shellReports(300)

    touch(field)
    vi.advanceTimersByTime(5000)
    shellReports(0)

    expect(document.activeElement).not.toBe(field)
  })

  it('refocuses a field the touch itself focused, as when an autocorrected word is tapped after Back', () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36'
    })
    const field = document.createElement('textarea')
    document.body.append(field)
    startBlurringOnKeyboardClose()

    touch(field)
    TextInputState.focusTextInput(field)
    shellReports(300)
    shellReports(0)
    vi.advanceTimersByTime(50)

    expect(document.activeElement).toBe(field)
  })

  it('still ends focus on a quick Back after a touch that landed on no field while nothing was focused', () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36'
    })
    const terminal = document.createElement('div')
    const terminalInput = document.createElement('textarea')
    document.body.append(terminal, terminalInput)
    startBlurringOnKeyboardClose()

    touch(terminal)
    TextInputState.focusTextInput(terminalInput)
    shellReports(300)
    shellReports(0)
    vi.advanceTimersByTime(50)

    expect(document.activeElement).not.toBe(terminalInput)
  })

  it('leaves focus alone on iOS, where only a blur closes the keyboard', () => {
    const field = focusedField('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)')
    startBlurringOnKeyboardClose()
    shellReports(300)

    shellReports(0)

    expect(document.activeElement).toBe(field)
  })
})
