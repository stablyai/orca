import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileTerminalInputRecovery } from './MobileTerminalInputRecovery'

const runtime = vi.hoisted(() => ({ focused: true, platform: 'android' }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => void) =>
      useEffect(() => (runtime.focused ? effect() : undefined), [effect, runtime.focused])
  }
})
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return runtime.platform
    }
  },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  runtime.focused = true
  runtime.platform = 'android'
  vi.unstubAllGlobals()
})

function mount() {
  const frames = new Map<number, () => void>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
  const button = { setNativeProps: vi.fn() }
  const onRecover = vi.fn()
  const element = () =>
    createElement(MobileTerminalInputRecovery, {
      failure: { outcome: 'unknown', reason: 'connection_interrupted' },
      recoveryUnavailable: false,
      onRecover
    })
  act(() => {
    renderer = create(element(), { createNodeMock: () => button })
  })
  return { frames, button, onRecover, update: () => act(() => renderer?.update(element())) }
}

it('focuses recovery once after mount without automatically recovering', () => {
  const { frames, button, onRecover, update } = mount()
  expect(button.setNativeProps).not.toHaveBeenCalled()
  act(() => frames.get(1)?.())
  expect(button.setNativeProps).toHaveBeenCalledExactlyOnceWith({ hasTVPreferredFocus: true })
  update()
  expect(button.setNativeProps).toHaveBeenCalledTimes(1)
  expect(onRecover).not.toHaveBeenCalled()
  act(() => renderer?.root.findByType('Pressable' as never).props.onPress())
  expect(onRecover).toHaveBeenCalledOnce()
})

it('cancels pending focus on route blur and requests it again on return', () => {
  const { frames, button, update } = mount()
  runtime.focused = false
  update()
  expect(frames.size).toBe(0)
  expect(button.setNativeProps).toHaveBeenCalledExactlyOnceWith({ hasTVPreferredFocus: false })
  runtime.focused = true
  update()
  act(() => frames.get(2)?.())
  expect(button.setNativeProps).toHaveBeenLastCalledWith({ hasTVPreferredFocus: true })
})

it('does not request focus while mounted on an inactive route', () => {
  runtime.focused = false
  const { frames, button } = mount()
  expect(frames.size).toBe(0)
  expect(button.setNativeProps).not.toHaveBeenCalled()
})

it('cancels pending focus when the warning unmounts', () => {
  const { frames } = mount()
  act(() => renderer?.unmount())
  renderer = null
  expect(frames.size).toBe(0)
})

it('does not use the Android focus prop on iOS', () => {
  runtime.platform = 'ios'
  const { frames, button } = mount()
  expect(frames.size).toBe(0)
  expect(button.setNativeProps).not.toHaveBeenCalled()
})
