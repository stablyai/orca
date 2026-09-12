import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FONT_SCALE_STEP, quantizeFontScale } from './mobile-native-chat-message-text'

const handlers: { start?: () => void; update?: (e: { scale: number }) => void } = {}

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
    act(() => renderer?.unmount())
    renderer = null
  })

  // Why this matters: `renderItem` closes over `fontScale`, so each committed
  // value re-measures every message in the list. Committing raw gesture scales
  // drives hundreds of whole-list re-measures per pinch, and a stray second
  // finger during an ordinary scroll starts that storm at scales the user cannot
  // even see. Those re-measures are what expose the recycled-paragraph repaint
  // that silently drops the tail of a long message.
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
})
