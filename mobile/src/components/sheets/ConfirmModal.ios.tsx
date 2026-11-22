import { useEffect, useRef } from 'react'
import { Alert, type AlertButton } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { ConfirmModalProps } from './ConfirmContent'
import { DrawnConfirmModal } from './DrawnConfirmModal'

export { ConfirmContent } from './ConfirmContent'
export type { ConfirmModalProps }

/** A UIKit alert, raised each time `visible` turns on; `media` or `details` keep the drawn sheet. */
export function ConfirmModal(props: ConfirmModalProps) {
  if (props.media || props.details) {
    return <DrawnConfirmModal {...props} />
  }
  return <ConfirmAlert {...props} />
}

function ConfirmAlert(props: ConfirmModalProps) {
  const t = useMobileTranslation()
  const scheme = useMobileColorScheme()
  const latest = useRef({ props, t, scheme })
  useEffect(() => {
    latest.current = { props, t, scheme }
  })

  // Only the rising edge presents, and each button answers the opening it shows.
  useEffect(() => {
    if (!props.visible) {
      return
    }
    const { props: shown, t: translate, scheme: style } = latest.current
    let active = true
    const answer = (press: (() => void) | undefined) => () => {
      if (!active) {
        return
      }
      active = false
      press?.()
      shown.onCancel()
    }
    const buttons: AlertButton[] = []
    if (shown.cancelLabel !== null) {
      buttons.push({
        text: shown.cancelLabel ?? translate('common.cancel', 'Cancel'),
        style: 'cancel',
        onPress: answer(shown.onCancelPress)
      })
    }
    buttons.push({
      text: shown.confirmLabel ?? translate('common.confirm', 'Confirm'),
      style: shown.destructive ? 'destructive' : 'default',
      isPreferred: !shown.destructive && buttons.length > 0,
      onPress: answer(shown.onConfirm)
    })
    Alert.alert(shown.title, shown.message, buttons, { userInterfaceStyle: style })
    // A UIKit alert can't be withdrawn, so a press after the caller closed it is dropped.
    return () => {
      active = false
    }
  }, [props.visible])

  return null
}
