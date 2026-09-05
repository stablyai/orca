import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileHardwareKeyboardCommands } from './use-mobile-hardware-keyboard-commands'
import { useHardwareKeyboardTextInputFocus } from './use-hardware-keyboard-text-input-focus'

const runtime = vi.hoisted(() => ({
  focused: true,
  connected: true,
  listener: null as null | ((event: { connected: boolean }) => void),
  register: vi.fn(() => vi.fn()),
  frames: [] as Array<() => void>
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => void) =>
      useEffect(() => {
        if (runtime.focused) {
          return effect()
        }
      }, [effect, runtime.focused])
  }
})
vi.mock('./mobile-hardware-keyboard-registry', () => ({
  registerMobileHardwareKeyboardScope: runtime.register
}))
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: vi.fn() }) } }))
vi.mock('@orca/expo-hardware-keyboard-navigation', () => ({
  isHardwareKeyboardConnected: () => runtime.connected,
  addHardwareKeyboardConnectionListener: (listener: typeof runtime.listener) => {
    runtime.listener = listener
    return {
      remove: () => {
        runtime.listener = null
      }
    }
  }
}))

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  runtime.focused = true
  runtime.connected = true
  runtime.frames = []
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('unregisters a retained route on blur and registers again on focus', () => {
  const actionIds = ['tab.nextAllTypes'] as const
  function Screen() {
    useMobileHardwareKeyboardCommands({ actionIds, context: 'app', onCommand: vi.fn() })
    return null
  }
  act(() => {
    renderer = create(createElement(Screen))
  })
  const unregister = runtime.register.mock.results[0].value
  runtime.focused = false
  act(() => renderer?.update(createElement(Screen)))
  expect(unregister).toHaveBeenCalledOnce()
  expect(runtime.register).toHaveBeenCalledTimes(1)
  runtime.focused = true
  act(() => renderer?.update(createElement(Screen)))
  expect(runtime.register).toHaveBeenCalledTimes(2)
})

it('restores soft input on disconnect and only refocuses a visible route on reconnect', () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => runtime.frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const input = { focus: vi.fn(), blur: vi.fn(), setNativeProps: vi.fn(), isFocused: () => true }
  const inputRef = { current: input } as never
  let softInput = true
  function Screen() {
    softInput = useHardwareKeyboardTextInputFocus({
      enabled: true,
      inputRef,
      surfaceId: 'chat'
    }).showSoftInputOnFocus
    return null
  }
  act(() => {
    renderer = create(createElement(Screen))
  })
  act(() => runtime.frames.shift()?.())
  expect(input.focus).toHaveBeenCalledOnce()
  expect(softInput).toBe(false)
  act(() => runtime.listener?.({ connected: false }))
  expect(softInput).toBe(true)
  expect(input.setNativeProps).toHaveBeenLastCalledWith({ showSoftInputOnFocus: true })
  runtime.focused = false
  act(() => renderer?.update(createElement(Screen)))
  act(() => runtime.listener?.({ connected: true }))
  expect(runtime.frames).toHaveLength(0)
  runtime.focused = true
  act(() => renderer?.update(createElement(Screen)))
  act(() => runtime.frames.shift()?.())
  expect(input.focus).toHaveBeenCalledTimes(2)
})
