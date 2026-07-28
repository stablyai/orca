import type { Component, ComponentType, RefAttributes } from 'react'
import type {
  NativeTerminalLiveInputViewHandle,
  NativeTerminalLiveInputViewProps
} from './ExpoTerminalLiveInput.types'

export function getNativeTerminalLiveInputView(): ComponentType<
  NativeTerminalLiveInputViewProps & RefAttributes<Component & NativeTerminalLiveInputViewHandle>
> | null {
  return null
}
