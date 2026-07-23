import { requireNativeViewManager } from 'expo-modules-core'
import type { ComponentType } from 'react'
import type { NativeTerminalLiveInputViewProps } from './ExpoTerminalLiveInput.types'

type NativeTerminalLiveInputView = ComponentType<NativeTerminalLiveInputViewProps>

// Why: requireNativeViewManager throws when the native module is absent (web/tests).
let NativeTerminalLiveInputView: NativeTerminalLiveInputView | null = null
try {
  NativeTerminalLiveInputView = requireNativeViewManager(
    'ExpoTerminalLiveInput'
  ) as NativeTerminalLiveInputView
} catch {
  NativeTerminalLiveInputView = null
}

export function getNativeTerminalLiveInputView(): NativeTerminalLiveInputView | null {
  return NativeTerminalLiveInputView
}
