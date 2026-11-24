import { memo } from 'react'
import { Text } from 'react-native'
import { useMobileMessageTime } from './use-mobile-message-time'
import { colors, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { scaledType } from './mobile-native-chat-message-styles'

/** A message's time as drawn ("2:10 PM", or with its day once it is older) and in full. */
export function useMobileNativeChatMessageTimeLabel(
  timestamp: number | null | undefined
): { short: string; full: string } | null {
  // A row with no time, such as waiting agent mail, keeps no clock running.
  const time = useMobileMessageTime(timestamp != null)
  if (timestamp == null) {
    return null
  }
  const short = time.label(timestamp)
  return short ? { short, full: time.full(timestamp) } : null
}

export const MobileNativeChatMessageTime = memo(function MobileNativeChatMessageTime({
  timestamp,
  fontScale
}: {
  timestamp: number | null | undefined
  fontScale: number
}): React.JSX.Element | null {
  useMobileColorScheme()
  const time = useMobileNativeChatMessageTimeLabel(timestamp)
  if (!time) {
    return null
  }
  return (
    <Text
      style={[styles.time, scaledType(typography.metaSize, fontScale, 5)]}
      accessibilityLabel={time.full}
    >
      {time.short}
    </Text>
  )
})

const styles = themedStyleSheet(() => ({
  time: {
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
}))
