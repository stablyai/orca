import { Pressable, Text, View, type ViewStyle } from 'react-native'
import { Bot, ChevronRight } from 'lucide-react-native'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader,
  sayNativeChatSubagentGroupEnglish as say,
  subagentStateLabel
} from '../../../../../src/shared/native-chat/transcript/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../../src/shared/native-chat-subagent-summary'
import { formatNativeChatDuration } from '../../../../../src/shared/native-chat-turn-status'
import type {
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../../../../src/shared/native-chat-types'
import { useNow } from '../../../hooks/use-now'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

function stateDotStyle(state: NativeChatSubagentState): ViewStyle {
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

// Isolate the one-second clock so ticks cannot rerender the containing message.
function Elapsed({
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

// Trust host-recorded child state: a parent turn ending does not prove its children stopped.
export function MobileNativeChatSubagentGroup({
  block,
  open,
  onToggle
}: {
  block: NativeChatSubagentGroupBlock
  // Transcript-owned group disclosure survives recycled rows.
  open: boolean
  onToggle?: (groupId: string) => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const header = nativeChatSubagentGroupHeader(block.agents, say)
  if (header.total === 0) {
    return null
  }
  const { working, headline, verdictState, verdict, alertState, alert, clockStartedAt } = header
  // Keep the live clock outside the live region or screen readers repeat the whole group every second.
  const settledElapsed =
    !working && clockStartedAt !== null && header.settledAt !== null
      ? formatNativeChatDuration(Math.max(0, (header.settledAt - clockStartedAt) / 1000))
      : null
  const accessibilityLabel = [
    headline,
    alert === null ? verdict : `${verdict} +${alert}`,
    settledElapsed,
    header.tokens
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return (
    <View testID="subagent-group" style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={accessibilityLabel}
        accessibilityLiveRegion="polite"
        hitSlop={6}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        onPress={() => onToggle?.(block.groupId)}
      >
        <Bot size={14} color={colors.textMuted} strokeWidth={2} />
        <View style={[styles.dot, stateDotStyle(alertState ?? verdictState)]} />
        <Text style={[styles.headline, working && styles.headlineWorking]} numberOfLines={1}>
          {headline}
        </Text>
        {/* Wraps under itself rather than pushing the headline or chevron out of a phone row. */}
        <Text style={styles.verdict}>
          {verdict}
          {alert === null ? null : ` +${alert}`}
          {clockStartedAt !== null ? (
            <>
              {' · '}
              <Elapsed startedAt={clockStartedAt} settledAt={header.settledAt} counting={working} />
            </>
          ) : null}
          {header.tokens !== null ? ` · ${header.tokens}` : null}
        </Text>
        <View style={open ? styles.caretOpen : undefined}>
          <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
      {open
        ? block.agents.map((agent) => {
            const state = normalizeSubagentState(agent.state)
            return (
              <View key={agent.id} testID="subagent-group-entry" style={styles.entry}>
                <View style={[styles.dot, stateDotStyle(state)]} />
                <Text
                  style={[styles.entryLabel, state === 'idle' && styles.entryLabelIdle]}
                  numberOfLines={1}
                >
                  {agent.label}
                </Text>
                <Text style={styles.entryState} numberOfLines={1}>
                  {subagentStateLabel(state, 1, 1, say)}
                  {typeof agent.tokens === 'number'
                    ? ` · ${formatSubagentTokens(agent.tokens)}`
                    : null}
                </Text>
              </View>
            )
          })
        : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  group: {
    paddingVertical: spacing.xs
  },
  header: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  pressed: {
    opacity: 0.6
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  headline: {
    flexShrink: 0,
    maxWidth: '60%',
    color: colors.textMuted,
    fontSize: typography.bodySize
  },
  headlineWorking: {
    color: colors.textPrimary
  },
  verdict: {
    flex: 1,
    minWidth: 0,
    textAlign: 'right',
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  entryState: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  },
  entry: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg + spacing.xs
  },
  entryLabel: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize
  },
  entryLabelIdle: {
    color: colors.textMuted
  }
}))
