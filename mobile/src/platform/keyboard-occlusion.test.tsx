import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: {
  endCoordinates: { height: number; screenY?: number }
  duration: number
}) => void

type KeyboardHarness = {
  listeners: Map<string, Listener>
  removed: string[]
  platform: 'ios' | 'android'
  // Count all subscriptions, not just surviving listeners, to detect transient duplicate keyboard work.
  addListenerCalls: number
  metrics: { height: number } | undefined
}

const keyboard = vi.hoisted((): KeyboardHarness => ({
  listeners: new Map(),
  removed: [],
  platform: 'ios',
  addListenerCalls: 0,
  metrics: undefined
}))

const regions = vi.hoisted(
  (): { listener: ((value: { keyboardInset?: number }) => void) | null; removed: boolean } => ({
    listener: null,
    removed: false
  })
)
vi.mock('../layout/reserved-regions', () => ({
  subscribeReservedRegionChanges: (listener: (value: { keyboardInset?: number }) => void) => {
    regions.listener = listener
    return () => {
      regions.listener = null
      regions.removed = true
    }
  }
}))

vi.mock('react-native', () => ({
  Keyboard: {
    metrics: () => keyboard.metrics,
    addListener: (name: string, listener: Listener) => {
      keyboard.addListenerCalls += 1
      keyboard.listeners.set(name, listener)
      return {
        remove: () => {
          keyboard.removed.push(name)
          keyboard.listeners.delete(name)
        }
      }
    }
  },
  Dimensions: { get: () => ({ height: 951 }) },
  Platform: {
    get OS() {
      return keyboard.platform
    }
  }
}))

import type * as KeyboardOcclusion from './keyboard-occlusion'
let keyboardModule: typeof KeyboardOcclusion

const subscribeSoftKeyboard: typeof KeyboardOcclusion.subscribeSoftKeyboard = (...args) =>
  keyboardModule.subscribeSoftKeyboard(...args)

describe('the keyboard the phone reports', () => {
  beforeEach(async () => {
    vi.resetModules()
    keyboardModule = await import('./keyboard-occlusion')
    keyboard.listeners.clear()
    keyboard.removed.length = 0
    keyboard.platform = 'ios'
    keyboard.addListenerCalls = 0
    keyboard.metrics = undefined
    regions.listener = null
    regions.removed = false
  })

  it.each(['before', 'after'])('ignores an offscreen frame %s hide without reopening', (order) => {
    const calls: string[] = []
    const unsubscribe = subscribeSoftKeyboard(
      (height, duration) => calls.push(`show ${height} ${duration}`),
      (duration) => calls.push(`hide ${duration}`)
    )
    keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 306 }, duration: 250 })
    const frame = () =>
      keyboard.listeners.get('keyboardWillChangeFrame')?.({
        endCoordinates: { height: 253, screenY: 951 },
        duration: 180
      })
    if (order === 'before') {
      frame()
    }
    keyboard.listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 253 }, duration: 180 })
    if (order === 'after') {
      frame()
    }
    // An overlapping transition's in-window frame must not override the explicit hide either.
    keyboard.listeners.get('keyboardWillChangeFrame')?.({
      endCoordinates: { height: 253, screenY: 698 },
      duration: 180
    })
    expect(calls).toEqual(['show 306 250', 'hide 180'])
    keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 306 }, duration: 250 })
    keyboard.listeners.get('keyboardWillChangeFrame')?.({
      endCoordinates: { height: 391, screenY: 560 },
      duration: 120
    })
    expect(calls.slice(-2)).toEqual(['show 306 250', 'show 391 120'])
    unsubscribe()
    expect(keyboard.listeners.size).toBe(3)
  })

  it('follows native geometry without keyboard events and preserves explicit hide ordering', () => {
    const calls: string[] = []
    const unsubscribe = subscribeSoftKeyboard(
      (height) => calls.push(`show ${height}`),
      () => calls.push('hide')
    )
    regions.listener?.({ keyboardInset: 495.5 })
    expect(calls).toEqual([])
    keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 495.5 }, duration: 0 })
    regions.listener?.({})
    regions.listener?.({ keyboardInset: 0 })
    expect(calls).toEqual(['show 495.5'])
    regions.listener?.({ keyboardInset: 311 })
    expect(calls).toEqual(['show 495.5', 'show 311'])
    keyboard.listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 311 }, duration: 180 })
    regions.listener?.({ keyboardInset: 495.5 })
    regions.listener?.({ keyboardInset: 0 })
    expect(calls).toEqual(['show 495.5', 'show 311', 'hide'])
    keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 0 }, duration: 0 })
    regions.listener?.({ keyboardInset: 311 })
    expect(calls.slice(-2)).toEqual(['show 0', 'show 311'])
    unsubscribe()
    expect(regions.removed).toBe(false)
  })
})
