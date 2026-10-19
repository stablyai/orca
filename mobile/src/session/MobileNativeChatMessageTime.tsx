import { memo } from 'react'
import { StyleSheet, Text } from 'react-native'
import {
  NATIVE_CHAT_MESSAGE_FULL_TIME_FORMAT,
  NATIVE_CHAT_MESSAGE_TIME_FORMAT
} from '../../../src/shared/native-chat-message-time'
import { colors, typography } from '../theme/mobile-theme'
import { scaledType } from './mobile-native-chat-message-styles'

let formatters: { time: Intl.DateTimeFormat; full: Intl.DateTimeFormat } | null = null

/** When a message was sent or written, as desktop's `NativeChatMessageTimestamp` shows it. */
export const MobileNativeChatMessageTime = memo(function MobileNativeChatMessageTime({
  timestamp,
  fontScale
}: {
  timestamp: number | null | undefined
  fontScale: number
}): React.JSX.Element | null {
  const date = timestamp == null ? null : new Date(timestamp)
  if (!date || Number.isNaN(date.getTime())) {
    return null
  }
  formatters ??= {
    time: new Intl.DateTimeFormat(undefined, NATIVE_CHAT_MESSAGE_TIME_FORMAT),
    full: new Intl.DateTimeFormat(undefined, NATIVE_CHAT_MESSAGE_FULL_TIME_FORMAT)
  }
  return (
    <Text
      style={[styles.time, scaledType(typography.metaSize, fontScale, 5)]}
      accessibilityLabel={formatters.full.format(date)}
    >
      {formatters.time.format(date)}
    </Text>
  )
})

const styles = StyleSheet.create({
  time: {
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
