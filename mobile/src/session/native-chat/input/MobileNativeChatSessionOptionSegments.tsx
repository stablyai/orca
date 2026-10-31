import { View } from 'react-native'
import { MobileSegmentedControl } from '../../../components/MobileSegmentedControl'
import { SectionHeader } from '../../../components/list/SectionHeader'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceShortLabel,
  nativeChatSessionOptionLabel
} from '../../../../../src/shared/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import { SessionOptionCaption } from './MobileNativeChatSessionOptionRows'

// Five fit across a phone's sheet; more read better as a list on their own page.
const MAX_SEGMENTS = 5

export function showsSessionOptionAsSegments(descriptor: SessionOptionDescriptor): boolean {
  return (
    descriptor.category === 'thought_level' &&
    descriptor.kind.type === 'select' &&
    !descriptor.action &&
    descriptor.kind.choices.length > 1 &&
    descriptor.kind.choices.length <= MAX_SEGMENTS
  )
}

export function SessionOptionSegments({
  descriptor,
  disabled,
  onSetOption
}: {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  if (descriptor.kind.type !== 'select') {
    return null
  }
  const { choices, currentValue } = descriptor.kind
  return (
    <View>
      <SectionHeader title={nativeChatSessionOptionLabel(descriptor, say)} />
      <MobileSegmentedControl
        segments={choices.map((choice) => ({
          value: choice.value,
          label: nativeChatSessionChoiceShortLabel(choice, say, descriptor.id)
        }))}
        // An unknown value marks nothing, rather than reading as a confirmed choice.
        selected={descriptor.valueSource === 'unknown' ? undefined : currentValue}
        onSelect={onSetOption}
        fill
        onSheet
        disabled={disabled || !descriptor.settable}
      />
      {sessionOptionDispatchUnconfirmed(descriptor) ? (
        <SessionOptionCaption>
          {t('chat.sessionOptionSegments.dispatchUnconfirmed', 'Sent to the agent — not confirmed')}
        </SessionOptionCaption>
      ) : null}
    </View>
  )
}
