import { createElement, useCallback, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callbacks = vi.hoisted(() => ({
  start: () => {},
  update: (_event: { scale: number }) => {},
  finalize: () => {}
}))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pinch: () => ({
      enabled() {
        return this
      },
      runOnJS() {
        return this
      },
      onStart(callback: () => void) {
        callbacks.start = callback
        return this
      },
      onUpdate(callback: (event: { scale: number }) => void) {
        callbacks.update = callback
        return this
      },
      onFinalize(callback: () => void) {
        callbacks.finalize = callback
        return this
      }
    })
  }
}))

import { useMarkdownTextScalePinchGesture } from './use-markdown-text-scale-pinch-gesture'

const storage = vi.hoisted(() => ({
  load: vi.fn<() => Promise<number>>(),
  save: vi.fn<(scale: number) => Promise<void>>()
}))
vi.mock('../storage/preferences', () => ({
  loadMarkdownTextScale: storage.load,
  saveMarkdownTextScale: storage.save
}))

type Store = ReturnType<typeof import('./use-markdown-text-scale').useMarkdownTextScale>

// The store is module state, so each test gets a fresh module.
async function mountSubscribers(count: number): Promise<Store[]> {
  vi.resetModules()
  const { useMarkdownTextScale } = await import('./use-markdown-text-scale')
  const latest: Store[] = []
  await act(async () => {
    for (let i = 0; i < count; i++) {
      const Probe = () => {
        latest[i] = useMarkdownTextScale()
        return null
      }
      create(createElement(Probe))
    }
  })
  return latest
}

describe('useMarkdownTextScale', () => {
  beforeEach(() => {
    storage.load.mockReset().mockResolvedValue(1)
    storage.save.mockReset().mockResolvedValue(undefined)
  })

  it('keeps two subscribers in sync and persists only the snapped commit', async () => {
    const stores = await mountSubscribers(2)
    const [a, b] = [() => stores[0], () => stores[1]]
    await act(async () => a().setLiveScale(1.35))
    expect(b().textScale).toBe(1.35)
    expect(storage.save).not.toHaveBeenCalled()

    await act(async () => a().commitTextScale(1.35))
    expect(b().textScale).toBe(1.25)
    expect(storage.save).toHaveBeenCalledExactlyOnceWith(1.25)
  })

  it('does not let a late storage load overwrite a pick', async () => {
    let finishLoad!: (scale: number) => void
    storage.load.mockReturnValue(new Promise((resolve) => (finishLoad = resolve)))
    const stores = await mountSubscribers(1)
    const a = () => stores[0]
    await act(async () => a().commitTextScale(1.5))
    await act(async () => finishLoad(0.65))
    expect(a().textScale).toBe(1.5)
  })

  it('adopts the stored scale when nothing was picked first', async () => {
    storage.load.mockResolvedValue(1.75)
    const stores = await mountSubscribers(1)
    const a = () => stores[0]
    expect(a().textScale).toBe(1.75)
  })
})

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('useMarkdownTextScalePinchGesture', () => {
  it('keeps successive pinches anchored at the 50% minimum', () => {
    let latestScale = 1.5
    const committed: number[] = []
    function Probe() {
      const [textScale, setTextScale] = useState(1.5)
      latestScale = textScale
      const commit = useCallback((scale: number) => {
        committed.push(scale)
        setTextScale(scale)
      }, [])
      useMarkdownTextScalePinchGesture({
        textScale,
        onLiveScale: setTextScale,
        onCommit: commit,
        combineWithNativeScroll: false
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    act(() => {
      callbacks.start()
      callbacks.update({ scale: 0.1 })
    })
    expect(latestScale).toBe(0.5)
    act(() => callbacks.finalize())
    expect(committed).toEqual([0.5])
    act(() => {
      callbacks.start()
      callbacks.update({ scale: 1.6 })
    })
    expect(latestScale).toBe(0.8)
    act(() => callbacks.finalize())
    expect(committed).toEqual([0.5, 0.8])
  })
})
