import { useRef } from 'react'
import type { KeyboardTypeOptions } from 'react-native'
import { Alert, Button, Host, Text, TextField, useNativeState } from '@expo/ui/swift-ui'
import { keyboardType as keyboardTypeModifier } from '@expo/ui/swift-ui/modifiers'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { NATIVE_ALERT_HOST_STYLE, NativeAlertAnchor } from './native-alert-anchor'
import { useNativeAlertOpening } from './native-alert-opening'
import type { TextInputModalProps } from './TextInputSheetContent'

export { TextInputSheetContent } from './TextInputSheetContent'
export type { TextInputModalProps }

/** A SwiftUI alert with a text field that follows `visible`. */
export function TextInputModal(props: TextInputModalProps) {
  const scheme = useMobileColorScheme()
  // A withdrawn prompt still settles its owner, e.g. a link prompt waiting on onAfterClose.
  const { opening, answer } = useNativeAlertOpening(props.visible, props, (shown) =>
    shown.onAfterClose?.()
  )
  if (!opening) {
    return null
  }
  return (
    <Host colorScheme={scheme} style={NATIVE_ALERT_HOST_STYLE} pointerEvents="none">
      <PromptAlert
        key={opening.id}
        shown={opening.props}
        presented={props.visible}
        answer={(respond) =>
          answer(opening.id, () => {
            respond()
            opening.props.onAfterClose?.()
          })
        }
      />
    </Host>
  )
}

function PromptAlert({
  shown,
  presented,
  answer
}: {
  shown: TextInputModalProps
  presented: boolean
  answer: (respond: () => void) => void
}) {
  const t = useMobileTranslation()
  const field = useNativeState(shown.defaultValue ?? '')
  const text = useRef(shown.defaultValue ?? '')
  const submit = () => {
    const value = text.current.trim()
    // The alert can't hold Save off while the field is empty, so an empty Save backs out.
    if (value || shown.allowEmpty) {
      shown.onSubmit(value)
    } else {
      shown.onCancel()
    }
  }
  return (
    <Alert title={shown.title} isPresented={presented}>
      <Alert.Trigger>
        <NativeAlertAnchor />
      </Alert.Trigger>
      <Alert.Actions>
        <TextField
          text={field}
          placeholder={shown.placeholder}
          autoFocus
          onTextChange={(value) => {
            text.current = value
          }}
          modifiers={[keyboardTypeModifier(swiftKeyboardType(shown.keyboardType))]}
        />
        <Button
          role="cancel"
          label={shown.cancelLabel ?? t('common.cancel', 'Cancel')}
          onPress={() => answer(shown.onCancel)}
        />
        <Button
          label={shown.submitLabel ?? t('common.save', 'Save')}
          onPress={() => answer(submit)}
        />
      </Alert.Actions>
      {shown.message ? (
        <Alert.Message>
          <Text>{shown.message}</Text>
        </Alert.Message>
      ) : null}
    </Alert>
  )
}

type SwiftKeyboardType = Parameters<typeof keyboardTypeModifier>[0]

const SWIFT_KEYBOARD_TYPES: Partial<Record<KeyboardTypeOptions, SwiftKeyboardType>> = {
  'email-address': 'email-address',
  numeric: 'numeric',
  'number-pad': 'numeric',
  'decimal-pad': 'decimal-pad',
  'phone-pad': 'phone-pad',
  url: 'url',
  'web-search': 'web-search'
}

function swiftKeyboardType(type: KeyboardTypeOptions | undefined): SwiftKeyboardType {
  return (type && SWIFT_KEYBOARD_TYPES[type]) ?? 'default'
}
