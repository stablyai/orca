import { memo } from 'react'
import { Text } from 'react-native'
import {
  getNativeChatMessageDay,
  getNativeChatMessageTimeFormatter
} from '../../../../../../src/shared/native-chat/transcript/messages/native-chat-message-time'
import { useSharedNowSnapshot } from '../../../../hooks/use-now'
import { colors, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { scaledType } from './mobile-native-chat-message-styles'

/** A message's time as drawn ("2:10 PM", or with its day once it is older) and in full. */
export function useMobileNativeChatMessageTimeLabel(
  timestamp: number | null | undefined
): { short: string; full: string } | null {
  const today = useSharedNowSnapshot(30_000, getNativeChatMessageDay)
  const date = timestamp == null ? null : new Date(timestamp)
  if (!date || Number.isNaN(date.getTime())) {
    return null
  }
  const formatter = getNativeChatMessageTimeFormatter(undefined, today)
  return { short: formatter.format(date, today.date), full: formatter.formatFull(date) }
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
