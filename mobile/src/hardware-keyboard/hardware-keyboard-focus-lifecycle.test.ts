import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileHardwareKeyboardCommands } from './use-mobile-hardware-keyboard-commands'
import { useHardwareKeyboardTextInputFocus } from './use-hardware-keyboard-text-input-focus'

const runtime = vi.hoisted(() => ({
  focused: true,
  connected: true,
  platform: 'android',
  listener: null as null | ((event: { connected: boolean }) => void),
  appStateListener: null as null | ((state: string) => void),
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
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return runtime.platform
    }
  },
  AppState: {
    addEventListener: (_event: string, listener: typeof runtime.appStateListener) => {
      runtime.appStateListener = listener
      return {
        remove: () => {
          runtime.appStateListener = null
        }
      }
    }
  }
}))
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
  runtime.platform = 'android'
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

function installCancellableFocusFrames() {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
}

it.each(['android', 'ios'])(
  'handles native touch refocus before the deferred request on %s',
  (platform) => {
    runtime.platform = platform
    installCancellableFocusFrames()
    let focused = false
    let nativeFocusRequests = 0
    const input = {
      focus: vi.fn(() => {
        if (!focused) {
          nativeFocusRequests++
          focused = true
        }
      }),
      blur: vi.fn(() => {
        focused = false
      }),
      setNativeProps: vi.fn(),
      isFocused: () => focused
    }
    const inputRef = { current: input } as never
    let touch = () => {}
    function Screen() {
      touch = useHardwareKeyboardTextInputFocus({
        enabled: true,
        inputRef,
        surfaceId: 'chat'
      }).handleTouchStart
      return null
    }
    act(() => {
      renderer = create(createElement(Screen))
    })
    act(() => {
      vi.advanceTimersByTime(16)
    })
    act(() => {
      touch()
    })
    focused = true
    nativeFocusRequests = 0
    act(() => {
      vi.runAllTimers()
    })
    expect(nativeFocusRequests).toBe(platform === 'android' ? 1 : 0)
    expect(input.blur).toHaveBeenCalledTimes(platform === 'android' ? 2 : 1)
    expect(input.setNativeProps).toHaveBeenLastCalledWith({ showSoftInputOnFocus: true })
  }
)

it('cancels queued hardware focus when the keyboard disconnects before the frame', () => {
  installCancellableFocusFrames()
  const input = { focus: vi.fn(), setNativeProps: vi.fn(), isFocused: () => false }
  const inputRef = { current: input } as never
  function Screen() {
    useHardwareKeyboardTextInputFocus({ enabled: true, inputRef, surfaceId: 'chat' })
    return null
  }
  act(() => {
    renderer = create(createElement(Screen))
  })
  act(() => {
    runtime.listener?.({ connected: false })
  })
  act(() => {
    vi.runAllTimers()
  })
  expect(input.focus).not.toHaveBeenCalled()
  expect(input.setNativeProps).toHaveBeenLastCalledWith({ showSoftInputOnFocus: true })
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels touch refocus and hardware verification when the retained route blurs', () => {
  installCancellableFocusFrames()
  const input = { focus: vi.fn(), blur: vi.fn(), setNativeProps: vi.fn(), isFocused: () => false }
  const inputRef = { current: input } as never
  let touch = () => {}
  function Screen() {
    touch = useHardwareKeyboardTextInputFocus({
      enabled: true,
      inputRef,
      surfaceId: 'chat'
    }).handleTouchStart
    return null
  }
  act(() => {
    renderer = create(createElement(Screen))
  })
  act(() => {
    vi.advanceTimersByTime(16)
  })
  expect(input.focus).toHaveBeenCalledOnce()
  act(() => {
    touch()
  })
  expect(input.blur).toHaveBeenCalledOnce()
  runtime.focused = false
  act(() => renderer?.update(createElement(Screen)))
  act(() => {
    vi.runAllTimers()
  })
  expect(input.focus).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('resamples a missed disconnect on foreground and releases both subscriptions on unmount', () => {
  installCancellableFocusFrames()
  const input = { focus: vi.fn(), setNativeProps: vi.fn(), isFocused: () => false }
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
  act(() => {
    vi.advanceTimersByTime(16)
  })
  expect(softInput).toBe(false)
  runtime.connected = false
  act(() => {
    runtime.appStateListener?.('active')
  })
  expect(softInput).toBe(true)
  expect(input.setNativeProps).toHaveBeenLastCalledWith({ showSoftInputOnFocus: true })
  act(() => {
    renderer?.unmount()
    renderer = null
  })
  act(() => {
    vi.runAllTimers()
  })
  expect(input.focus).toHaveBeenCalledOnce()
  expect(runtime.listener).toBeNull()
  expect(runtime.appStateListener).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([0, 16])(
  'keeps software input enabled after touch at %ims supersedes hardware focus',
  (elapsed) => {
    installCancellableFocusFrames()
    const input = { focus: vi.fn(), blur: vi.fn(), setNativeProps: vi.fn(), isFocused: () => false }
    const inputRef = { current: input } as never
    let touch = () => {}
    function Screen() {
      touch = useHardwareKeyboardTextInputFocus({
        enabled: true,
        inputRef,
        surfaceId: 'chat'
      }).handleTouchStart
      return null
    }
    act(() => {
      renderer = create(createElement(Screen))
    })
    act(() => {
      vi.advanceTimersByTime(elapsed)
    })
    act(() => {
      touch()
    })
    input.focus.mockClear()
    act(() => {
      vi.runAllTimers()
    })
    expect(input.setNativeProps).toHaveBeenLastCalledWith({ showSoftInputOnFocus: true })
    expect(input.focus).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  }
)
