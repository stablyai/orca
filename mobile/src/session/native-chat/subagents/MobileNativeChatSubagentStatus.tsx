import type { ViewStyle } from 'react-native'
import { formatNativeChatDuration } from '../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatSubagentState } from '../../../../../src/shared/native-chat/native-chat-types'
import { useNow } from '../../../hooks/use-now'
import { colors } from '../../../theme/mobile-theme'

export function subagentStateDotStyle(state: NativeChatSubagentState): ViewStyle {
  switch (state) {
    case 'working':
      return { backgroundColor: colors.textPrimary }
    case 'failed':
      return { backgroundColor: colors.statusRed }
    case 'idle':
      return { backgroundColor: colors.textMuted, opacity: 0.4 }
    case 'completed':
      return { backgroundColor: colors.textMuted, opacity: 0.6 }
    case 'stopped':
    case 'unverifiable':
      return { backgroundColor: colors.textMuted }
  }
}

// Isolate the one-second clock so ticks cannot rerender the containing view.
export function SubagentElapsed({
  startedAt,
  settledAt,
  counting
}: {
  startedAt: number
  settledAt: number | null
  counting: boolean
}): React.JSX.Element {
  const now = useNow(1_000, counting)
  const end = counting ? now : (settledAt ?? now)
  return <>{formatNativeChatDuration(Math.max(0, (end - startedAt) / 1000))}</>
}
