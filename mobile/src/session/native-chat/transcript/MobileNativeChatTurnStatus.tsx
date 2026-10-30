import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { nativeChatElapsedSeconds } from '../../../../../src/shared/native-chat-turn-status'
import {
  formatMobileNativeChatTurnStatusLabel,
  nativeChatTurnStatusCopy
} from '../native-chat-turn-status-copy'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { AgentTurnOutcome } from '../../../../../src/shared/agent-turn-outcome'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useNow } from '../../../hooks/use-now'

// Stop ticking settled turns so old transcripts retain no timers.
function useElapsedSeconds(startedAt: number | null, counting: boolean): number {
  // Preserves the pre-stamp epoch for the frame before the turn's startedAt lands.
  const [mountedAt] = useState(() => Date.now())
  const now = useNow(1_000, counting)
  return counting ? nativeChatElapsedSeconds(startedAt, mountedAt, now) : 0
}

export function MobileNativeChatTurnStatus({
  startedAt,
  workedSeconds,
  verdict,
  expanded = false,
  onToggleExpanded
}: {
  startedAt: number | null
  workedSeconds?: number | null
  verdict?: AgentTurnOutcome
  expanded?: boolean
  onToggleExpanded?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const settled = workedSeconds != null
  const elapsedSeconds = useElapsedSeconds(startedAt, !settled)
  const label = formatMobileNativeChatTurnStatusLabel({ workedSeconds, elapsedSeconds, verdict }, t)

  if (settled && onToggleExpanded) {
    return (
      <Pressable
        style={({ pressed }) => [styles.row, styles.bar, pressed && styles.pressed]}
        onPress={onToggleExpanded}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={nativeChatTurnStatusCopy(t).toggleDetails}
      >
        <Text style={styles.label}>{label}</Text>
        <View style={expanded ? styles.caretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
    )
  }

  return (
    <View style={[styles.row, styles.bar]}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 28,
    paddingHorizontal: spacing.md
  },
  bar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  pressed: {
    opacity: 0.6
  },
  label: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  }
}))
