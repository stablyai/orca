import { useEffect, useRef } from 'react'
import { Alert, type AlertButton } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { ConfirmModalProps } from './ConfirmContent'

export { ConfirmContent } from './ConfirmContent'
export type { ConfirmModalProps }

/** A UIKit alert, raised each time `visible` turns on; `media` and `details` stay with the drawn sheet. */
export function ConfirmModal(props: ConfirmModalProps) {
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
    const answer = (press: (() => void) | undefined) => () => {
      press?.()
      latest.current.props.onCancel()
    }
    const buttons: AlertButton[] = []
    if (shown.cancelLabel !== null) {
      buttons.push({
        text: shown.cancelLabel ?? translate('common.cancel', 'Cancel'),
        style: 'cancel',
        onPress: answer(() => latest.current.props.onCancelPress?.())
      })
    }
    buttons.push({
      text: shown.confirmLabel ?? translate('common.confirm', 'Confirm'),
      style: shown.destructive ? 'destructive' : 'default',
      isPreferred: !shown.destructive && buttons.length > 0,
      onPress: answer(() => latest.current.props.onConfirm?.())
    })
    Alert.alert(shown.title, shown.message, buttons, { userInterfaceStyle: style })
  }, [props.visible])

  return null
}
