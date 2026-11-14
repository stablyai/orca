import { ListGroup } from '../../../components/list/ListGroup'
import { SectionHeader } from '../../../components/list/ListGroup'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  isReadOnlySessionOptionValue,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionOptionLabel } from '../../../../../src/shared/native-chat/input/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import { mobileSessionOptionSummaryValue } from './mobile-native-chat-session-option-labels'
import {
  descriptorRowElements,
  SessionOptionSummaryRow,
  showsSessionOptionAsSwitch
} from './MobileNativeChatSessionOptionRows'
export function OptionRows({
  descriptors,
  permission,
  permissionColor,
  locked,
  onNavigate,
  onSetOption
}: {
  descriptors: readonly SessionOptionDescriptor[]
  permission: SessionOptionDescriptor | undefined
  permissionColor: string | undefined
  locked: (descriptor: SessionOptionDescriptor) => boolean
  onNavigate: (page: string) => void
  onSetOption: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  if (descriptors.length === 0) {
    return null
  }
  return (
    <>
      <SectionHeader title={t('chat.sessionOptionPickers.optionsSection', 'Options')} />
      <ListGroup>
        {descriptors.flatMap((descriptor) => {
          const isPermission = descriptor === permission
          const disabled = locked(descriptor) || !descriptor.settable
          if (showsSessionOptionAsSwitch(descriptor)) {
            return descriptorRowElements(
              {
                descriptor,
                disabled,
                onSetOption: (value) => onSetOption(descriptor, value),
                onInvokeAction: () => onNavigate(descriptor.id)
              },
              t
            )
          }
          return [
            <SessionOptionSummaryRow
              key={descriptor.id}
              label={
                isPermission
                  ? t('chat.sessionOptionPickers.permissions', 'Permissions')
                  : nativeChatSessionOptionLabel(descriptor, say)
              }
              value={mobileSessionOptionSummaryValue(descriptor)}
              valueColor={isPermission ? permissionColor : undefined}
              disabled={disabled}
              onPress={
                isReadOnlySessionOptionValue(descriptor)
                  ? undefined
                  : () => onNavigate(descriptor.id)
              }
            />
          ]
        })}
      </ListGroup>
    </>
  )
}
