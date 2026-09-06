import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeModule: null as null | { supportsHardwarePaste?: boolean }
}))
vi.mock('expo-modules-core', () => ({
  requireNativeViewManager: () => 'NativeCaptureView',
  requireOptionalNativeModule: () => mocks.nativeModule
}))
vi.mock('react-native', () => ({ View: 'View' }))
import { HardwareKeyboardCaptureView } from '../../packages/expo-hardware-keyboard/src/HardwareKeyboardCaptureView'

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  mocks.nativeModule = null
})

it.each([null, {}, { supportsHardwarePaste: false }])(
  'omits paste opt-in for older native builds: %j',
  (nativeModule) => {
    mocks.nativeModule = nativeModule
    act(() => {
      renderer = create(createElement(HardwareKeyboardCaptureView, { hardwarePaste: true }))
    })
    expect(renderer!.root.findByType('NativeCaptureView').props).not.toHaveProperty('hardwarePaste')
  }
)

it.each([true, false, undefined])(
  'forwards paste opt-in only when capable: %j',
  (hardwarePaste) => {
    mocks.nativeModule = { supportsHardwarePaste: true }
    act(() => {
      renderer = create(createElement(HardwareKeyboardCaptureView, { hardwarePaste }))
    })
    expect(renderer!.root.findByType('NativeCaptureView').props.hardwarePaste).toBe(
      hardwarePaste ?? false
    )
  }
)
