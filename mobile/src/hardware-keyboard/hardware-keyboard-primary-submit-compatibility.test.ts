import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  nativeModule: null as null | { supportsPrimaryModifierSubmit?: boolean }
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

describe('primary-modifier submit compatibility', () => {
  it.each([null, {}, { supportsPrimaryModifierSubmit: false }])(
    'retains legacy native behavior without advertising an unsupported prop: %j',
    (nativeModule) => {
      mocks.nativeModule = nativeModule
      act(() => {
        renderer = create(
          createElement(HardwareKeyboardCaptureView, {
            mode: 'submit',
            submitWithPrimaryModifier: true
          })
        )
      })
      const props = renderer!.root.findByType('NativeCaptureView').props
      expect(props.mode).toBe('submit')
      expect(props).not.toHaveProperty('submitWithPrimaryModifier')
    }
  )

  it.each([true, false])('forwards opt-in %j only to capable native builds', (enabled) => {
    mocks.nativeModule = { supportsPrimaryModifierSubmit: true }
    act(() => {
      renderer = create(
        createElement(HardwareKeyboardCaptureView, {
          mode: 'submit',
          submitWithPrimaryModifier: enabled
        })
      )
    })
    expect(renderer!.root.findByType('NativeCaptureView').props.submitWithPrimaryModifier).toBe(
      enabled
    )
  })
})
