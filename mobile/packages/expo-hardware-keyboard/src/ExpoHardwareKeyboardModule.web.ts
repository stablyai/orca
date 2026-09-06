import type { ComponentType } from 'react'
import type { HardwareKeyboardCaptureViewProps } from './ExpoHardwareKeyboard.types'

export function supportsHardwarePaste(): boolean {
  return false
}

export function supportsPrimaryModifierSubmit(): boolean {
  return false
}

export function supportsNativeFieldBoundaries(): boolean {
  return false
}

export function getNativeHardwareKeyboardCaptureView(): ComponentType<HardwareKeyboardCaptureViewProps> | null {
  return null
}
