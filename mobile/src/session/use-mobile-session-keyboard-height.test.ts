import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveMobileSessionKeyboardLift,
  useMobileSessionKeyboardHeight
} from './use-mobile-session-keyboard-height'

type KeyboardHandler = (event: { endCoordinates: { height: number; screenY?: number } }) => void

const keyboard = vi.hoisted(() => {
  const handlers = new Map<string, KeyboardHandler>()
  return {
    handlers,
    addListener: vi.fn((name: string, handler: KeyboardHandler) => {
      handlers.set(name, handler)
      return { remove: vi.fn(() => handlers.delete(name)) }
    })
  }
})

vi.mock('react-native', () => ({
  Keyboard: {
    addListener: keyboard.addListener
  },
  Platform: { OS: 'android' },
  Dimensions: { get: () => ({ height: 800 }) }
}))

function KeyboardHeightHarness(props: {
  notifyKeyboardVisibility: (visible: boolean) => void
}): ReturnType<typeof createElement> {
  const height = useMobileSessionKeyboardHeight(props.notifyKeyboardVisibility)
  return createElement('KeyboardHeight', { height })
}

describe('mobile session keyboard height', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    keyboard.handlers.clear()
    keyboard.addListener.mockClear()
  })

  it('tracks Android keyboard show, height changes, and hide through native events', () => {
    const notifyKeyboardVisibility = vi.fn()
    act(() => {
      renderer = create(createElement(KeyboardHeightHarness, { notifyKeyboardVisibility }))
    })

    const height = () => renderer!.root.findByType('KeyboardHeight').props.height
    expect(height()).toBe(0)
    expect([...keyboard.handlers.keys()]).toEqual([
      'keyboardDidShow',
      'keyboardDidHide',
      'keyboardDidChangeFrame'
    ])

    act(() => keyboard.handlers.get('keyboardDidShow')?.({ endCoordinates: { height: 320 } }))
    expect(height()).toBe(320)
    act(() =>
      keyboard.handlers.get('keyboardDidChangeFrame')?.({ endCoordinates: { height: 280 } })
    )
    expect(height()).toBe(280)
    act(() =>
      keyboard.handlers.get('keyboardDidChangeFrame')?.({
        endCoordinates: { height: 280, screenY: 800 }
      })
    )
    expect(height()).toBe(0)
    act(() => keyboard.handlers.get('keyboardDidHide')?.({ endCoordinates: { height: 0 } }))
    expect(height()).toBe(0)
    expect(notifyKeyboardVisibility.mock.calls).toEqual([[true], [true], [false], [false]])
  })

  it('uses the full Android IME height and removes the iOS safe-area overlap', () => {
    expect(
      resolveMobileSessionKeyboardLift({
        keyboardHeight: 320,
        bottomInset: 24,
        platform: 'android'
      })
    ).toBe(320)
    expect(
      resolveMobileSessionKeyboardLift({
        keyboardHeight: 320,
        bottomInset: 24,
        platform: 'ios'
      })
    ).toBe(296)
  })
})
