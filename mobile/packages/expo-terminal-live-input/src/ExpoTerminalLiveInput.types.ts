import type { NativeSyntheticEvent, StyleProp, TextStyle, ViewProps } from 'react-native'

export type TerminalLiveInputKeyPressEvent = NativeSyntheticEvent<{
  readonly key: string
}>

export type TerminalLiveInputCommittedTextEvent = NativeSyntheticEvent<{
  readonly text: string
}>

export type TerminalLiveInputTerminalEnterEvent = NativeSyntheticEvent<Record<string, never>>
export type TerminalLiveInputFocusEvent = NativeSyntheticEvent<Record<string, never>>

export type TerminalLiveInputViewProps = ViewProps & {
  readonly editable?: boolean
  readonly style?: StyleProp<TextStyle>
  /** Applied only by the RN TextInput fallback when the native module is unavailable. */
  readonly value?: string
  readonly onCommittedText?: (text: string) => void
  readonly onKeyPress?: (event: TerminalLiveInputKeyPressEvent) => void
  readonly onTerminalEnter?: () => void
}

export type TerminalLiveInputViewHandle = {
  focus: () => void
  blur: () => void
  isFocused: () => boolean
  setNativeProps: (props: { text?: string }) => void
}

export type NativeTerminalLiveInputViewProps = ViewProps & {
  readonly editable?: boolean
  readonly onCommittedText?: (event: TerminalLiveInputCommittedTextEvent) => void
  readonly onInputFocus?: (event: TerminalLiveInputFocusEvent) => void
  readonly onInputBlur?: (event: TerminalLiveInputFocusEvent) => void
  readonly onKeyPress?: (event: TerminalLiveInputKeyPressEvent) => void
  readonly onTerminalEnter?: (event: TerminalLiveInputTerminalEnterEvent) => void
  readonly focusAsync?: () => Promise<boolean>
  readonly blurAsync?: () => Promise<boolean>
  readonly setTextAsync?: (text: string) => Promise<void>
}
