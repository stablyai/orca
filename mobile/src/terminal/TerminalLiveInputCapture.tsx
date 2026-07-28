import type { RefObject } from 'react'
import {
  Platform,
  TextInput,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type TextStyle
} from 'react-native'
import {
  TerminalLiveInputView,
  type TerminalEditorTransaction
} from '@orca/expo-terminal-live-input'
import type { TerminalLiveInputCaptureHandle } from './terminal-live-input-capture-handle'
import { getTerminalLiveInputKeyboardType } from './terminal-keyboard-type'

type TerminalLiveInputCaptureProps = {
  readonly editable: boolean
  readonly inputRef: RefObject<TerminalLiveInputCaptureHandle | null>
  readonly onEditorTransaction: (transaction: TerminalEditorTransaction) => void
  readonly onKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void
  readonly onLegacyChange: (text: string) => void
  readonly onSubmit: () => void
  readonly revisioned: boolean
  readonly style: StyleProp<TextStyle>
  readonly value: string
}

export function TerminalLiveInputCapture({
  editable,
  inputRef,
  onEditorTransaction,
  onKeyPress,
  onLegacyChange,
  onSubmit,
  revisioned,
  style,
  value
}: TerminalLiveInputCaptureProps): React.JSX.Element {
  if (revisioned) {
    return (
      <TerminalLiveInputView
        ref={inputRef}
        style={style}
        value={value}
        onEditorTransaction={onEditorTransaction}
        onKeyPress={onKeyPress}
        onTerminalEnter={onSubmit}
        showSoftInputOnFocus
        editable={editable}
      />
    )
  }

  return (
    <TextInput
      ref={(input) => {
        inputRef.current = input
      }}
      style={style}
      value={value}
      onChangeText={onLegacyChange}
      onKeyPress={onKeyPress}
      onSubmitEditing={onSubmit}
      placeholder=""
      showSoftInputOnFocus
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      smartInsertDelete={false}
      // Why: iOS textContentType overrides autoComplete and can narrow the keyboard.
      autoComplete="off"
      keyboardType={getTerminalLiveInputKeyboardType(Platform.OS)}
      returnKeyType="default"
      blurOnSubmit={false}
      editable={editable}
      importantForAutofill="no"
    />
  )
}
