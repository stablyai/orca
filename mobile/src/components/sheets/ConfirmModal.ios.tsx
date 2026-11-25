import { Alert, Button, Host, Text } from '@expo/ui/swift-ui'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { ConfirmModalProps } from './ConfirmContent'
import { DrawnConfirmModal } from './DrawnConfirmModal'
import { NATIVE_ALERT_HOST_STYLE, NativeAlertAnchor } from './native-alert-anchor'
import { useNativeAlertOpening } from './native-alert-opening'

export { ConfirmContent } from './ConfirmContent'
export type { ConfirmModalProps }

/** A SwiftUI alert that follows `visible`; `media` or `details` keep the drawn sheet. */
export function ConfirmModal(props: ConfirmModalProps) {
  if (props.media || props.details) {
    return <DrawnConfirmModal {...props} />
  }
  return <ConfirmAlert {...props} />
}

function ConfirmAlert(props: ConfirmModalProps) {
  const t = useMobileTranslation()
  const scheme = useMobileColorScheme()
  const { opening, answer } = useNativeAlertOpening(props.visible, props)
  if (!opening) {
    return null
  }
  const { id, props: shown } = opening
  const respond = (press: (() => void) | undefined) => () =>
    answer(id, () => {
      press?.()
      shown.onCancel()
    })
  return (
    <Host colorScheme={scheme} style={NATIVE_ALERT_HOST_STYLE} pointerEvents="none">
      <Alert key={id} title={shown.title} isPresented={props.visible}>
        <Alert.Trigger>
          <NativeAlertAnchor />
        </Alert.Trigger>
        <Alert.Actions>
          {shown.cancelLabel !== null ? (
            <Button
              role="cancel"
              label={shown.cancelLabel ?? t('common.cancel', 'Cancel')}
              onPress={respond(shown.onCancelPress)}
            />
          ) : null}
          <Button
            role={shown.destructive ? 'destructive' : 'default'}
            label={shown.confirmLabel ?? t('common.confirm', 'Confirm')}
            onPress={respond(shown.onConfirm)}
          />
        </Alert.Actions>
        {shown.message ? (
          <Alert.Message>
            <Text>{shown.message}</Text>
          </Alert.Message>
        ) : null}
      </Alert>
    </Host>
  )
}
