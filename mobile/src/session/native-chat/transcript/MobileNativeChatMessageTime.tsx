import { memo } from 'react'
import { Text } from 'react-native'
import {
  getNativeChatMessageDay,
  getNativeChatMessageTimeFormatter
} from '../../../../../src/shared/native-chat/transcript/native-chat-message-time'
import { useSharedNowSnapshot } from '../../../hooks/use-now'
import { colors, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { scaledType } from './mobile-native-chat-message-styles'

export const MobileNativeChatMessageTime = memo(function MobileNativeChatMessageTime({
  timestamp,
  fontScale
}: {
  timestamp: number | null | undefined
  fontScale: number
}): React.JSX.Element | null {
  useMobileColorScheme()
  const today = useSharedNowSnapshot(30_000, getNativeChatMessageDay)
  const date = timestamp == null ? null : new Date(timestamp)
  if (!date || Number.isNaN(date.getTime())) {
    return null
  }
  const formatter = getNativeChatMessageTimeFormatter(undefined, today)
  return (
    <Text
      style={[styles.time, scaledType(typography.metaSize, fontScale, 5)]}
      accessibilityLabel={formatter.formatFull(date)}
    >
      {formatter.format(date, today.date)}
    </Text>
  )
})

const styles = themedStyleSheet(() => ({
  time: {
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
}))
