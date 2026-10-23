import { StyleSheet, View } from 'react-native'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { SectionHeader } from '../components/ui/SectionHeader'
import { spacing } from '../theme/mobile-theme'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import { SessionOptionCaption } from './MobileNativeChatSessionOptionRows'

// Five fit across a phone's sheet; more read better as a list on their own page.
const MAX_SEGMENTS = 5

/** An effort-like choice the model page can show in place, as one segmented control. */
export function showsSessionOptionAsSegments(descriptor: SessionOptionDescriptor): boolean {
  return (
    descriptor.category === 'thought_level' &&
    descriptor.kind.type === 'select' &&
    !descriptor.action &&
    descriptor.kind.choices.length > 1 &&
    descriptor.kind.choices.length <= MAX_SEGMENTS
  )
}

/** Its own section: the option's name as the header, the 36 pt control on the sheet's edge. */
export function SessionOptionSegments({
  descriptor,
  disabled,
  onSetOption
}: {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
}): React.JSX.Element | null {
  if (descriptor.kind.type !== 'select') {
    return null
  }
  const { choices, currentValue } = descriptor.kind
  return (
    <View>
      <SectionHeader title={descriptor.label} />
      <View style={styles.control}>
        <MobileSegmentedControl
          segments={choices}
          // An unknown value marks nothing, rather than reading as a confirmed choice.
          selected={descriptor.valueSource === 'unknown' ? undefined : currentValue}
          onSelect={onSetOption}
          fill
          disabled={disabled || !descriptor.settable}
        />
      </View>
      {sessionOptionDispatchUnconfirmed(descriptor) ? (
        <SessionOptionCaption>Sent to the agent, not confirmed yet.</SessionOptionCaption>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  control: {
    marginHorizontal: spacing.lg
  }
})
