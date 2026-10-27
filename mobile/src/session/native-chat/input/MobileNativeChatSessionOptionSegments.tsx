import { StyleSheet, Text, View } from 'react-native'
import { MobileSegmentedControl } from '../../../components/MobileSegmentedControl'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
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
  if (descriptor.kind.type !== 'select') {
    return null
  }
  const { choices, currentValue } = descriptor.kind
  return (
    <View style={styles.block}>
      <Text style={styles.label}>{descriptor.label}</Text>
      <MobileSegmentedControl
        segments={choices}
        // An unknown value marks nothing, rather than reading as a confirmed choice.
        selected={descriptor.valueSource === 'unknown' ? undefined : currentValue}
        onSelect={onSetOption}
        fill
        disabled={disabled || !descriptor.settable}
      />
      {sessionOptionDispatchUnconfirmed(descriptor) ? (
        <SessionOptionCaption>Sent to the agent — not confirmed</SessionOptionCaption>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  block: {
    marginTop: spacing.md
  },
  label: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.xs,
    paddingBottom: 6
  }
})
