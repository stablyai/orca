import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import {
  TextInput,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type TextInput as TextInputType,
  type TextStyle,
  type ViewProps
} from 'react-native'
import { getNativeTerminalLiveInputView } from './ExpoTerminalLiveInputModule'
import type {
  TerminalLiveInputCommittedTextEvent,
  TerminalLiveInputFocusEvent,
  TerminalLiveInputKeyPressEvent,
  TerminalLiveInputTerminalEnterEvent,
  TerminalLiveInputViewHandle,
  TerminalLiveInputViewProps
} from './ExpoTerminalLiveInput.types'

const NativeView = getNativeTerminalLiveInputView()

type NativeViewMethods = {
  focusAsync?: () => Promise<boolean>
  blurAsync?: () => Promise<boolean>
  setTextAsync?: (text: string) => Promise<void>
}

/**
 * Composition-aware live terminal input surface.
 * Uses the native view when available; falls back to RN TextInput for web/tests.
 */
export const TerminalLiveInputView = forwardRef<
  TerminalLiveInputViewHandle,
  TerminalLiveInputViewProps
>(function TerminalLiveInputView(
  { editable = true, style, value, onCommittedText, onKeyPress, onTerminalEnter, ...rest },
  ref
): React.JSX.Element {
  const nativeRef = useRef<(React.Component & NativeViewMethods) | null>(null)
  const fallbackRef = useRef<TextInputType | null>(null)
  const focusedRef = useRef(false)

  useImperativeHandle(
    ref,
    (): TerminalLiveInputViewHandle => ({
      focus: () => {
        if (!editable) {
          return
        }
        focusedRef.current = true
        if (nativeRef.current?.focusAsync) {
          void nativeRef.current
            .focusAsync()
            .then((didFocus) => {
              if (!didFocus) {
                focusedRef.current = false
              }
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
        if (nativeRef.current?.blurAsync) {
          void nativeRef.current
            .blurAsync()
            .then((didBlur) => {
              if (!didBlur) {
                focusedRef.current = true
              }
            })
            .catch(() => {
              focusedRef.current = true
            })
          return
        }
        fallbackRef.current?.blur()
      },
      isFocused: () => {
        return focusedRef.current
      },
      setNativeProps: (props: { text?: string }) => {
        if (props.text === undefined) {
          return
        }
        if (nativeRef.current?.setTextAsync) {
          void nativeRef.current.setTextAsync(props.text).catch(() => {})
          return
        }
        fallbackRef.current?.setNativeProps({ text: props.text })
      }
    }),
    [editable]
  )

  const handleNativeCommittedText = useCallback(
    (event: TerminalLiveInputCommittedTextEvent) => {
      onCommittedText?.(event.nativeEvent.text)
    },
    [onCommittedText]
  )

  const handleNativeKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      onKeyPress?.(event)
    },
    [onKeyPress]
  )

  const handleNativeFocus = useCallback((_event: TerminalLiveInputFocusEvent) => {
    focusedRef.current = true
  }, [])

  const handleNativeBlur = useCallback((_event: TerminalLiveInputFocusEvent) => {
    focusedRef.current = false
  }, [])

  const handleNativeTerminalEnter = useCallback(
    (_event: TerminalLiveInputTerminalEnterEvent) => {
      onTerminalEnter?.()
    },
    [onTerminalEnter]
  )

  if (NativeView) {
    const ResolvedNativeView = NativeView as React.ComponentType<
      ViewProps & {
        editable?: boolean
        style?: StyleProp<TextStyle>
        onCommittedText?: (event: TerminalLiveInputCommittedTextEvent) => void
        onInputFocus?: (event: TerminalLiveInputFocusEvent) => void
        onInputBlur?: (event: TerminalLiveInputFocusEvent) => void
        onKeyPress?: (event: TerminalLiveInputKeyPressEvent) => void
        onTerminalEnter?: (event: TerminalLiveInputTerminalEnterEvent) => void
        ref?: React.Ref<React.Component & NativeViewMethods>
      }
    >
    return (
      <ResolvedNativeView
        ref={nativeRef}
        editable={editable}
        style={style}
        onCommittedText={handleNativeCommittedText}
        onInputFocus={handleNativeFocus}
        onInputBlur={handleNativeBlur}
        onKeyPress={handleNativeKeyPress}
        onTerminalEnter={handleNativeTerminalEnter}
        {...rest}
      />
    )
  }

  return (
    <TextInput
      ref={fallbackRef}
      style={style}
      editable={editable}
      value={value}
      onChangeText={(text) => {
        onCommittedText?.(text)
      }}
      onKeyPress={(event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (event.nativeEvent.key !== 'Enter') {
          onKeyPress?.(event as TerminalLiveInputKeyPressEvent)
        }
      }}
      onSubmitEditing={() => {
        onTerminalEnter?.()
      }}
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
      accessibilityLabel={rest.accessibilityLabel}
      testID={rest.testID}
      pointerEvents={rest.pointerEvents}
      nativeID={rest.nativeID}
    />
  )
})
