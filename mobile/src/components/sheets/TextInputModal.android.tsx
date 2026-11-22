import { useEffect, useRef, useState } from 'react'
import type { KeyboardTypeOptions } from 'react-native'
import {
  AlertDialog,
  Column,
  Host,
  Text,
  TextButton,
  TextField,
  useNativeState,
  type TextFieldKeyboardType
} from '@expo/ui/jetpack-compose'
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { TextInputModalProps } from './TextInputSheetContent'
import { DIALOG_HOST_STYLE, DIALOG_TITLE_STYLE } from './native-dialog-host'

export { TextInputSheetContent } from './TextInputSheetContent'
export type { TextInputModalProps }

/** A Material 3 dialog holding one text field; it stays up until the caller closes it. */
export function TextInputModal({ visible, onAfterClose, ...dialogProps }: TextInputModalProps) {
  const scheme = useMobileColorScheme()
  const afterClose = useRef(onAfterClose)
  const wasVisible = useRef(visible)
  useEffect(() => {
    afterClose.current = onAfterClose
  })
  useEffect(() => {
    if (wasVisible.current && !visible) {
      afterClose.current?.()
    }
    wasVisible.current = visible
  }, [visible])

  if (!visible) {
    return null
  }
  return (
    <Host matchContents colorScheme={scheme} style={DIALOG_HOST_STYLE}>
      <TextInputDialog {...dialogProps} />
    </Host>
  )
}

// Mounted per opening, so the field starts from `defaultValue` each time.
function TextInputDialog({
  title,
  message,
  defaultValue = '',
  placeholder,
  submitLabel,
  cancelLabel,
  selectTextOnFocus = false,
  allowEmpty = false,
  keyboardType,
  onSubmit,
  onCancel
}: Omit<TextInputModalProps, 'visible' | 'onAfterClose'>) {
  const t = useMobileTranslation()
  const field = useNativeState(defaultValue)
  const selection = useNativeState({
    start: selectTextOnFocus ? 0 : defaultValue.length,
    end: defaultValue.length
  })
  const [value, setValue] = useState(defaultValue)
  const canSubmit = allowEmpty || value.trim().length > 0

  function submit(text: string) {
    if (allowEmpty || text.trim().length > 0) {
      onSubmit(text.trim())
    }
  }

  return (
    <AlertDialog onDismissRequest={onCancel}>
      <AlertDialog.Title>
        <Text style={DIALOG_TITLE_STYLE}>{title}</Text>
      </AlertDialog.Title>
      <AlertDialog.Text>
        <Column verticalArrangement={{ spacedBy: 16 }}>
          {message ? <Text>{message}</Text> : null}
          <TextField
            value={field}
            selection={selection}
            onValueChange={setValue}
            autoFocus
            singleLine
            keyboardOptions={{
              keyboardType: composeKeyboardType(keyboardType),
              capitalization: 'none',
              autoCorrectEnabled: false,
              imeAction: 'done'
            }}
            keyboardActions={{ onDone: submit }}
            modifiers={[fillMaxWidth()]}
          >
            {placeholder ? (
              <TextField.Placeholder>
                <Text>{placeholder}</Text>
              </TextField.Placeholder>
            ) : null}
          </TextField>
        </Column>
      </AlertDialog.Text>
      <AlertDialog.ConfirmButton>
        <TextButton enabled={canSubmit} onClick={() => submit(value)}>
          <Text>{submitLabel ?? t('common.save', 'Save')}</Text>
        </TextButton>
      </AlertDialog.ConfirmButton>
      <AlertDialog.DismissButton>
        <TextButton onClick={onCancel}>
          <Text>{cancelLabel ?? t('common.cancel', 'Cancel')}</Text>
        </TextButton>
      </AlertDialog.DismissButton>
    </AlertDialog>
  )
}

function composeKeyboardType(type: KeyboardTypeOptions | undefined): TextFieldKeyboardType {
  switch (type) {
    case 'url':
      return 'uri'
    case 'email-address':
      return 'email'
    case 'numeric':
    case 'number-pad':
      return 'number'
    case 'decimal-pad':
      return 'decimal'
    case 'phone-pad':
      return 'phone'
    case 'ascii-capable':
      return 'ascii'
    default:
      return 'text'
  }
}
