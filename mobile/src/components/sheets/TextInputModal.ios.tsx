import { useEffect, useRef } from 'react'
import { Alert } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { TextInputModalProps } from './TextInputSheetContent'

export { TextInputSheetContent } from './TextInputSheetContent'
export type { TextInputModalProps }

/** A UIKit alert with a text field, raised each time `visible` turns on. */
export function TextInputModal(props: TextInputModalProps) {
  const t = useMobileTranslation()
  const scheme = useMobileColorScheme()
  const latest = useRef({ props, t, scheme })
  useEffect(() => {
    latest.current = { props, t, scheme }
  })

  // Only the rising edge presents: a UIKit alert can't be updated or withdrawn once shown.
  useEffect(() => {
    if (!props.visible) {
      return
    }
    const { props: shown, t: translate, scheme: style } = latest.current
    Alert.prompt(
      shown.title,
      shown.message,
      [
        {
          text: shown.cancelLabel ?? translate('common.cancel', 'Cancel'),
          style: 'cancel',
          onPress: () => {
            latest.current.props.onCancel()
            latest.current.props.onAfterClose?.()
          }
        },
        {
          text: shown.submitLabel ?? translate('common.save', 'Save'),
          isPreferred: true,
          onPress: (text) => {
            const current = latest.current.props
            const value = (text ?? '').trim()
            // The alert can't hold Save off while the field is empty, so an empty Save backs out.
            if (value || current.allowEmpty) {
              current.onSubmit(value)
            } else {
              current.onCancel()
            }
            current.onAfterClose?.()
          }
        }
      ],
      PROMPT_TYPE,
      shown.defaultValue ?? '',
      shown.keyboardType,
      { userInterfaceStyle: style }
    )
  }, [props.visible])

  return null
}

// Alert.prompt's field kind, not copy.
const PROMPT_TYPE = 'plain-text'
