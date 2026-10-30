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

  it('leaves focus alone on iOS, where only a blur closes the keyboard', () => {
    const field = focusedField('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)')
    startBlurringOnKeyboardClose()
    shellReports(300)

    shellReports(0)

    expect(document.activeElement).toBe(field)
  })
})
