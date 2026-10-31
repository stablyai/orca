import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
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

import type { SoftKeyboardState } from './keyboard-occlusion'
import type * as KeyboardOcclusion from './keyboard-occlusion'
let keyboardModule: typeof KeyboardOcclusion
const currentSoftKeyboardHeight = () => keyboardModule.currentSoftKeyboardHeight()
const subscribeSoftKeyboard: typeof KeyboardOcclusion.subscribeSoftKeyboard = (...args) =>
  keyboardModule.subscribeSoftKeyboard(...args)
const useKeyboardOcclusion = () => keyboardModule.useKeyboardOcclusion()
const useSoftKeyboard = () => keyboardModule.useSoftKeyboard()

let lift = 0
let keyboardState: SoftKeyboardState = { height: 0, visible: false }

function Harness(): null {
  lift = useKeyboardOcclusion()
  return null
}

function StateHarness(): null {
  keyboardState = useSoftKeyboard()
  return null
}

async function mountComponent(component: () => null): Promise<ReturnType<typeof create>> {
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(createElement(component))
  })
  if (tree === null) {
    throw new Error('the harness did not mount')
  }
  return tree
}

const mount = async (): Promise<ReturnType<typeof create>> => mountComponent(Harness)

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
    lift = 0
    keyboardState = { height: 0, visible: false }
  })

  it('subscribes to will events on iOS and did events on Android', async () => {
    await mount()
    expect([...keyboard.listeners.keys()].sort()).toEqual([
      'keyboardWillChangeFrame',
      'keyboardWillHide',
      'keyboardWillShow'
    ])

    keyboard.platform = 'android'
    vi.resetModules()
    keyboardModule = await import('./keyboard-occlusion')
    keyboard.listeners.clear()
    await mount()
    expect([...keyboard.listeners.keys()].sort()).toEqual(['keyboardDidHide', 'keyboardDidShow'])
  })

  it('lifts by the height the event carries and drops back on hide', async () => {
    await mount()
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({
        endCoordinates: { height: 336 },
        duration: 250
      })
    })
    expect(lift).toBe(336)
    await act(async () => {
      keyboard.listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 0 }, duration: 0 })
    })
    expect(lift).toBe(0)
  })

  it('never reports a negative height, whatever the event says', async () => {
    await mount()
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: -10 }, duration: 0 })
    })
    expect(lift).toBe(0)
  })

  it('removes consumer callbacks on unmount while preserving visibility observation', async () => {
    const tree = await mount()
    await act(async () => tree.unmount())
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 999 }, duration: 0 })
    })
    expect(lift).toBe(0)
    expect(keyboard.removed).toEqual([])
  })

  it('answers both facts from one subscription, so a screen wanting each pays for one', async () => {
    await mountComponent(StateHarness)
    expect(keyboard.addListenerCalls).toBe(3)
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({
        endCoordinates: { height: 336 },
        duration: 250
      })
    })
    expect(keyboardState).toEqual({ height: 336, visible: true })
    await act(async () => {
      keyboard.listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 0 }, duration: 0 })
    })
    expect(keyboardState).toEqual({ height: 0, visible: false })
  })

  it('calls a keyboard that reports no height open anyway, because the event is the fact', async () => {
    await mountComponent(StateHarness)
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 0 }, duration: 0 })
    })
    expect(keyboardState).toEqual({ height: 0, visible: true })
  })

  it('hands a sheet each event with its duration, and removes its callbacks', () => {
    const calls: string[] = []
    const unsubscribe = subscribeSoftKeyboard(
      (height, duration) => calls.push(`show ${height} ${duration}`),
      (duration) => calls.push(`hide ${duration}`)
    )
    keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 336 }, duration: 250 })
    keyboard.listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 0 }, duration: 180 })
    expect(calls).toEqual(['show 336 250', 'hide 180'])
    unsubscribe()
    keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 999 }, duration: 0 })
    expect(calls).toEqual(['show 336 250', 'hide 180'])
    expect(keyboard.removed).toEqual([])
  })

  it('updates an open keyboard when unfolding changes its frame without another show', async () => {
    await mountComponent(StateHarness)
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({
        endCoordinates: { height: 391, screenY: 560 },
        duration: 250
      })
      keyboard.listeners.get('keyboardWillChangeFrame')?.({
        endCoordinates: { height: 306, screenY: 645 },
        duration: 180
      })
    })
    expect(keyboardState).toEqual({ height: 306, visible: true })
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

  it('retains explicit visibility across resubscriptions and observes hide while detached', async () => {
    const first = subscribeSoftKeyboard(
      () => undefined,
      () => undefined
    )
    keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 495.5 }, duration: 0 })
    first()
    const calls: number[] = []
    const second = subscribeSoftKeyboard(
      (height) => calls.push(height),
      () => undefined
    )
    regions.listener?.({ keyboardInset: 311 })
    expect(calls).toEqual([311])
    expect(keyboard.addListenerCalls).toBe(3)
    second()
    keyboard.listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 311 }, duration: 180 })
    keyboard.metrics = { height: 311 }
    const third = subscribeSoftKeyboard(
      (height) => calls.push(height),
      () => undefined
    )
    regions.listener?.({ keyboardInset: 495.5 })
    expect(calls).toEqual([311])
    third()
  })

  it('does not subscribe Android to native iOS geometry', () => {
    keyboard.platform = 'android'
    const unsubscribe = subscribeSoftKeyboard(
      () => undefined,
      () => undefined
    )
    expect(regions.listener).toBeNull()
    unsubscribe()
  })

  it('reads a keyboard already up from metrics(), and 0 when there is none', () => {
    expect(currentSoftKeyboardHeight()).toBe(0)
    keyboard.metrics = { height: 291 }
    expect(currentSoftKeyboardHeight()).toBe(291)
  })

  it('never seeds the hook from metrics(), so a stale iOS reading cannot open it', async () => {
    // RN clears metrics on didHide, after the willHide used here.
    keyboard.metrics = { height: 291 }
    await mountComponent(StateHarness)
    expect(keyboardState).toEqual({ height: 0, visible: false })
  })
})
