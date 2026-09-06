import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core'
import type { ComponentType } from 'react'
import type { HardwareKeyboardCaptureViewProps } from './ExpoHardwareKeyboard.types'

type NativeCaptureView = ComponentType<HardwareKeyboardCaptureViewProps>

export function supportsNativeFieldBoundaries(): boolean {
  return (
    requireOptionalNativeModule<{ supportsNativeFieldBoundaries?: boolean }>('ExpoHardwareKeyboard')
      ?.supportsNativeFieldBoundaries === true
  )
}

// Why: requireNativeViewManager throws when the native module is absent (web/tests).
let NativeHardwareKeyboardCaptureView: NativeCaptureView | null = null
try {
  NativeHardwareKeyboardCaptureView = requireNativeViewManager(
    'ExpoHardwareKeyboard'
  ) as NativeCaptureView
} catch {
  NativeHardwareKeyboardCaptureView = null
}

export function getNativeHardwareKeyboardCaptureView(): NativeCaptureView | null {
  return NativeHardwareKeyboardCaptureView
}
