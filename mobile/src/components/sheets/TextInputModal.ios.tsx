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

  const opening = useRef<{ active: boolean } | null>(null)

  // Only the rising edge presents, and each button answers the opening it shows.
  useEffect(() => {
    if (!props.visible) {
      // A UIKit alert can't be withdrawn, so a press after the caller closed it is dropped.
      const withdrawn = opening.current
      opening.current = null
      if (withdrawn?.active) {
        withdrawn.active = false
        latest.current.props.onAfterClose?.()
      }
      return
    }
    const { props: shown, t: translate, scheme: style } = latest.current
    const current = { active: true }
    opening.current = current
    const answer = (respond: () => void) => {
      if (!current.active) {
        return
      }
      current.active = false
      respond()
      shown.onAfterClose?.()
    }
    Alert.prompt(
      shown.title,
      shown.message,
      [
        {
          text: shown.cancelLabel ?? translate('common.cancel', 'Cancel'),
          style: 'cancel',
          onPress: () => answer(shown.onCancel)
        },
        {
          text: shown.submitLabel ?? translate('common.save', 'Save'),
          isPreferred: true,
          onPress: (text) =>
            answer(() => {
              const value = (text ?? '').trim()
              // The alert can't hold Save off while the field is empty, so an empty Save backs out.
              if (value || shown.allowEmpty) {
                shown.onSubmit(value)
              } else {
                shown.onCancel()
              }
            })
        }
      ],
      PROMPT_TYPE,
      shown.defaultValue ?? '',
      shown.keyboardType,
      { userInterfaceStyle: style }
    )
  }, [props.visible])

  useEffect(
    () => () => {
      if (opening.current) {
        opening.current.active = false
      }
    },
    []
  )

  return null
}

// Alert.prompt's field kind, not copy.
const PROMPT_TYPE = 'plain-text'
