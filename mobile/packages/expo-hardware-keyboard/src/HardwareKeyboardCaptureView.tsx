import React from 'react'
import { View, type ViewProps } from 'react-native'
import { getNativeHardwareKeyboardCaptureView } from './ExpoHardwareKeyboardModule'
import type { HardwareKeyboardCaptureViewProps } from './ExpoHardwareKeyboard.types'

type Props = HardwareKeyboardCaptureViewProps & ViewProps

const NativeView = getNativeHardwareKeyboardCaptureView()

/**
 * Wraps the live-terminal TextInput so physical keys enter the native
 * responder/view chain. Falls back to a plain View on web/tests.
 */
export function HardwareKeyboardCaptureView({
  enabled = true,
  onHardwareKey,
  children,
  style,
  ...rest
}: Props): React.JSX.Element {
  if (!NativeView) {
    return (
      <View style={style} {...rest}>
        {children}
      </View>
    )
  }

  return (
    <NativeView enabled={enabled} onHardwareKey={onHardwareKey} style={style} {...rest}>
      {children}
    </NativeView>
  )
}
