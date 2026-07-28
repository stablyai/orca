import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import {
  TextInput,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextInput as TextInputType
} from 'react-native'
import { getNativeTerminalLiveInputView } from './ExpoTerminalLiveInputModule'
import type {
  NativeTerminalLiveInputViewHandle,
  TerminalLiveInputKeyPressEvent,
  TerminalLiveInputTransactionEvent,
  TerminalLiveInputViewHandle,
  TerminalLiveInputViewProps
} from './ExpoTerminalLiveInput.types'

const NativeView = getNativeTerminalLiveInputView()

export const TerminalLiveInputView = forwardRef<
  TerminalLiveInputViewHandle,
  TerminalLiveInputViewProps
>(function TerminalLiveInputView(
  {
    editable = true,
    value,
    showSoftInputOnFocus,
    onEditorTransaction,
    onKeyPress,
    onTerminalEnter,
    ...rest
  },
  ref
): React.JSX.Element {
  const nativeRef = useRef<(React.Component & NativeTerminalLiveInputViewHandle) | null>(null)
  const fallbackRef = useRef<TextInputType | null>(null)
  const fallbackRevisionRef = useRef(0)
  const focusedRef = useRef(false)

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (!editable) {
          return
        }
        focusedRef.current = true
        if (nativeRef.current) {
          void nativeRef.current
            .focusAsync()
            .then((focused) => {
              focusedRef.current = focused
            })
            .catch(() => {
              focusedRef.current = false
            })
          return
        }
        fallbackRef.current?.focus()
      },
      blur: () => {
        focusedRef.current = false
        if (nativeRef.current) {
          void nativeRef.current
            .blurAsync()
            .then((blurred) => {
              focusedRef.current = !blurred
            })
            .catch(() => {
              focusedRef.current = true
            })
          return
        }
        fallbackRef.current?.blur()
      },
      isFocused: () => focusedRef.current,
      setNativeProps: ({ text }) => {
        if (text === undefined) {
          return
        }
        if (nativeRef.current) {
          void nativeRef.current.setTextAsync(text).catch(() => {})
          return
        }
        fallbackRef.current?.setNativeProps({ text })
      }
    }),
    [editable]
  )

  const handleNativeTransaction = useCallback(
    (event: TerminalLiveInputTransactionEvent) => {
      onEditorTransaction?.(event.nativeEvent)
    },
    [onEditorTransaction]
  )

  if (NativeView) {
    return (
      <NativeView
        {...rest}
        ref={nativeRef}
        editable={editable}
        onEditorStateTransaction={handleNativeTransaction}
        onInputFocus={() => {
          focusedRef.current = true
        }}
        onInputBlur={() => {
          focusedRef.current = false
        }}
        onKeyPress={onKeyPress}
        onTerminalEnter={onTerminalEnter}
      />
    )
  }

  return (
    <TextInput
      {...rest}
      ref={fallbackRef}
      editable={editable}
      value={value}
      showSoftInputOnFocus={showSoftInputOnFocus}
      onChangeText={(text) => {
        fallbackRevisionRef.current += 1
        onEditorTransaction?.({
          revision: fallbackRevisionRef.current,
          text,
          composingStart: null,
          composingEnd: null
        })
      }}
      onKeyPress={(event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (event.nativeEvent.key !== 'Enter') {
          onKeyPress?.(event as TerminalLiveInputKeyPressEvent)
        }
      }}
      onSubmitEditing={onTerminalEnter}
      onFocus={() => {
        focusedRef.current = true
      }}
      onBlur={() => {
        focusedRef.current = false
      }}
      autoCapitalize="none"
      autoComplete="off"
      autoCorrect={false}
      importantForAutofill="no"
      spellCheck={false}
      smartInsertDelete={false}
      blurOnSubmit={false}
      keyboardType="default"
      returnKeyType="default"
    />
  )
})
