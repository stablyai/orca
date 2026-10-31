import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FONT_SCALE_STEP, quantizeFontScale } from './mobile-native-chat-message-text'
import { NATIVE_CHAT_TEXT_SCALE_KEY } from './mobile-native-chat-text-scale'

const handlers: { start?: () => void; update?: (e: { scale: number }) => void } = {}
const storage = vi.hoisted(() => {
  const saved = new Map<string, string>()
  const gate: { read: (key: string) => Promise<string | null> } = {
    read: async (key) => saved.get(key) ?? null
  }
  return {
    saved,
    gate,
    getItem: (key: string) => gate.read(key),
    setItem: async (key: string, value: string) => {
      saved.set(key, value)
    }
  }
})

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: storage.getItem, setItem: storage.setItem }
}))

vi.mock('react-native-gesture-handler', () => {
  const pinch = {
    runOnJS: () => pinch,
    onStart: (cb: () => void) => {
      handlers.start = cb
      return pinch
    },
    onUpdate: (cb: (e: { scale: number }) => void) => {
      handlers.update = cb
      return pinch
    }
  }
  return {
    Gesture: { Simultaneous: (...g: unknown[]) => g, Native: () => ({}), Pinch: () => pinch }
  }
})

import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'

describe('quantizeFontScale', () => {
  it('snaps to the commit step and stays inside the supported range', () => {
    expect(quantizeFontScale(1)).toBe(1)
    expect(quantizeFontScale(1.01)).toBe(1)
    expect(quantizeFontScale(1.024)).toBe(1)
    expect(quantizeFontScale(1.03)).toBe(1.05)
    expect(quantizeFontScale(5)).toBe(1.8)
    expect(quantizeFontScale(0.1)).toBe(0.8)
    expect(quantizeFontScale(Number.NaN)).toBe(1)
  })

  it('collapses a full-range pinch to at most one commit per step', () => {
    const committed = new Set<number>()
    for (let i = 0; i <= 600; i++) {
      committed.add(quantizeFontScale(0.7 + i * 0.002))
    }
    expect(committed.size).toBeLessThanOrEqual(Math.round(1 / FONT_SCALE_STEP) + 1)
  })
})

describe('useMobileNativeChatPinchGesture', () => {
  let renderer: { unmount: () => void } | null = null
  let latest = 1

  function Probe(): null {
    latest = useMobileNativeChatPinchGesture().fontScale
    return null
  }

  beforeEach(() => {
    latest = 1
    act(() => {
      renderer = create(createElement(Probe))
    })
  })

  afterEach(() => {
    storage.gate.read = async (key) => storage.saved.get(key) ?? null
    act(() => renderer?.unmount())
    renderer = null
  })

  // Each committed scale remeasures the whole list; raw/inadvertent pinches expose recycled-paragraph clipping, so commits must be quantized.
  it('commits nothing for gesture noise the user cannot see', () => {
    act(() => handlers.start?.())
    for (const scale of [1.001, 0.995, 1.008, 1.02, 0.982]) {
      act(() => handlers.update?.({ scale }))
    }
    expect(latest).toBe(1)
  })

  it('commits a real pinch, on the step grid', () => {
    act(() => handlers.start?.())
    act(() => handlers.update?.({ scale: 1.34 }))
    expect(latest).toBe(1.35)
    act(() => handlers.update?.({ scale: 1.37 }))
    expect(latest).toBe(1.35)
    act(() => handlers.update?.({ scale: 1.42 }))
    expect(latest).toBe(1.4)
  })

  it('stores the pinched size and reloads it after the chat view is gone', async () => {
    act(() => renderer?.unmount())
    storage.saved.clear()
    vi.resetModules()
    const first = await import('./use-mobile-native-chat-pinch-gesture')
    let scale = 1
    function First(): null {
      scale = first.useMobileNativeChatPinchGesture().fontScale
      return null
    }
    await act(async () => {
      renderer = create(createElement(First))
    })
    await act(async () => {
      handlers.start?.()
      handlers.update?.({ scale: 1.34 })
    })
    expect(scale).toBe(1.35)
    expect(storage.saved.get(NATIVE_CHAT_TEXT_SCALE_KEY)).toBe('1.35')
    act(() => renderer?.unmount())

    vi.resetModules()
    const second = await import('./use-mobile-native-chat-pinch-gesture')
    function Second(): null {
      scale = second.useMobileNativeChatPinchGesture().fontScale
      return null
    }
    await act(async () => {
      renderer = create(createElement(Second))
    })
    expect(scale).toBe(1.35)
  })

  it('keeps a pinch that lands before the stored size is read', async () => {
    act(() => renderer?.unmount())
    storage.saved.clear()
    vi.resetModules()
    let release: (value: string | null) => void = () => {}
    storage.gate.read = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const { useMobileNativeChatPinchGesture: usePinch } =
      await import('./use-mobile-native-chat-pinch-gesture')
    let scale = 1
    function Reloaded(): null {
      scale = usePinch().fontScale
      return null
    }
    await act(async () => {
      renderer = create(createElement(Reloaded))
    })
    await act(async () => {
      handlers.start?.()
      handlers.update?.({ scale: 1.34 })
    })
    expect(scale).toBe(1.35)
    await act(async () => {
      release('1')
    })
    expect(scale).toBe(1.35)
    expect(storage.saved.get(NATIVE_CHAT_TEXT_SCALE_KEY)).toBe('1.35')
  })
})
