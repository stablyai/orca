import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeModule: null as null | { supportsNativeFieldBoundaries?: boolean }
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

describe('native field boundary compatibility', () => {
  it.each([null, {}, { supportsNativeFieldBoundaries: false }])(
    'omits the new prop when the installed module lacks support: %j',
    (nativeModule) => {
      mocks.nativeModule = nativeModule
      act(() => {
        renderer = create(
          createElement(HardwareKeyboardCaptureView, { nativeFieldBoundaries: true })
        )
      })
      expect(renderer!.root.findByType('NativeCaptureView').props).not.toHaveProperty(
        'nativeFieldBoundaries'
      )
    }
  )

  it.each([true, false])('forwards the explicit opt-in %j to a capable module', (enabled) => {
    mocks.nativeModule = { supportsNativeFieldBoundaries: true }
    act(() => {
      renderer = create(
        createElement(HardwareKeyboardCaptureView, { nativeFieldBoundaries: enabled })
      )
    })
    expect(renderer!.root.findByType('NativeCaptureView').props.nativeFieldBoundaries).toBe(enabled)
  })
})
