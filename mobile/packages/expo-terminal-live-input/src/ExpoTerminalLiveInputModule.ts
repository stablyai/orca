import { requireNativeViewManager } from 'expo-modules-core'
import type { Component, ComponentType, RefAttributes } from 'react'
import type {
  NativeTerminalLiveInputViewHandle,
  NativeTerminalLiveInputViewProps
} from './ExpoTerminalLiveInput.types'

type NativeTerminalLiveInputComponent = ComponentType<
  NativeTerminalLiveInputViewProps & RefAttributes<Component & NativeTerminalLiveInputViewHandle>
>

let NativeTerminalLiveInputView: NativeTerminalLiveInputComponent | null = null
try {
  NativeTerminalLiveInputView = requireNativeViewManager(
    'ExpoTerminalLiveInput'
  ) as NativeTerminalLiveInputComponent
} catch {
  NativeTerminalLiveInputView = null
}

export function getNativeTerminalLiveInputView(): NativeTerminalLiveInputComponent | null {
  return NativeTerminalLiveInputView
}

export function isNativeTerminalLiveInputAvailable(): boolean {
  return NativeTerminalLiveInputView !== null
}
