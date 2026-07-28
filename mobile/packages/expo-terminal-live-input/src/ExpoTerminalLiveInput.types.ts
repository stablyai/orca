import type { NativeSyntheticEvent, StyleProp, TextStyle, ViewProps } from 'react-native'

export type TerminalEditorTransaction = {
  readonly revision: number
  readonly text: string
  readonly composingStart: number | null
  readonly composingEnd: number | null
}

export type TerminalLiveInputTransactionEvent = NativeSyntheticEvent<TerminalEditorTransaction>

export type TerminalLiveInputKeyPressEvent = NativeSyntheticEvent<{
  readonly key: string
}>

export type TerminalLiveInputViewProps = ViewProps & {
  readonly editable?: boolean
  readonly style?: StyleProp<TextStyle>
  readonly value?: string
  readonly showSoftInputOnFocus?: boolean
  readonly onEditorTransaction?: (transaction: TerminalEditorTransaction) => void
  readonly onKeyPress?: (event: TerminalLiveInputKeyPressEvent) => void
  readonly onTerminalEnter?: () => void
}

export type TerminalLiveInputViewHandle = {
  focus: () => void
  blur: () => void
  isFocused?: () => boolean
  setNativeProps: (props: { text?: string }) => void
}

export type NativeTerminalLiveInputViewHandle = {
  focusAsync: () => Promise<boolean>
  blurAsync: () => Promise<boolean>
  setTextAsync: (text: string) => Promise<void>
}

export type NativeTerminalLiveInputViewProps = ViewProps & {
  readonly editable?: boolean
  readonly style?: StyleProp<TextStyle>
  readonly onEditorStateTransaction?: (event: TerminalLiveInputTransactionEvent) => void
  readonly onInputFocus?: (event: NativeSyntheticEvent<Record<string, never>>) => void
  readonly onInputBlur?: (event: NativeSyntheticEvent<Record<string, never>>) => void
  readonly onKeyPress?: (event: TerminalLiveInputKeyPressEvent) => void
  readonly onTerminalEnter?: (event: NativeSyntheticEvent<{ readonly revision: number }>) => void
}
