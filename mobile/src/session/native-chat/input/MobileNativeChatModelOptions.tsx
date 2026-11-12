import { View } from 'react-native'
import { ListGroup, SectionHeader } from '../../../components/list/ListGroup'
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
import {
  SessionOptionSlider,
  showsSessionOptionAsSlider
} from './MobileNativeChatSessionOptionSlider'
import { sessionOptionPickerStyles as styles } from './mobile-native-chat-session-option-picker-styles'
import { useResponsiveLayout } from '../../../layout/responsive-layout'

export function MobileNativeChatModelOptions(props: {
  options: readonly SessionOptionDescriptor[]
  permission: SessionOptionDescriptor | undefined
  permissionColor: string | undefined
  locked: (descriptor: SessionOptionDescriptor) => boolean
  onNavigate: (page: string) => void
  onSetOption: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
}): React.JSX.Element {
  const { options, onSetOption, locked } = props
  const { isLandscapePhone } = useResponsiveLayout()
  const sliders = options.filter(showsSessionOptionAsSlider)
  return (
    <View style={[styles.modelOptions, isLandscapePhone && styles.modelOptionsLandscape]}>
      {sliders.length > 0 ? (
        <View style={isLandscapePhone && styles.modelOptionColumn}>
          {sliders.map((descriptor) => (
            <SessionOptionSlider
              key={descriptor.id}
              descriptor={descriptor}
              disabled={locked(descriptor)}
              onSetOption={(value) => onSetOption(descriptor, value)}
            />
          ))}
        </View>
      ) : null}
      <View style={isLandscapePhone && styles.modelOptionColumn}>
        <OptionRows
          {...props}
          hideHeading={isLandscapePhone}
          descriptors={[
            ...options.filter((descriptor) => !showsSessionOptionAsSlider(descriptor)),
            ...(props.permission ? [props.permission] : [])
          ]}
        />
      </View>
    </View>
  )
}

function OptionRows({
  descriptors,
  permission,
  permissionColor,
  locked,
  onNavigate,
  onSetOption,
  hideHeading
}: {
  descriptors: readonly SessionOptionDescriptor[]
  permission: SessionOptionDescriptor | undefined
  permissionColor: string | undefined
  locked: (descriptor: SessionOptionDescriptor) => boolean
  onNavigate: (page: string) => void
  onSetOption: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
  hideHeading?: boolean
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  if (descriptors.length === 0) {
    return null
  }
  return (
    <>
      {hideHeading ? null : (
        <SectionHeader title={t('chat.sessionOptionPickers.optionsSection', 'Options')} />
      )}
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
