import { useContext } from 'react'
import { Pressable, Text, View, type ViewStyle } from 'react-native'
import { Bot, ChevronRight } from 'lucide-react-native'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader,
  subagentStateLabel
} from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import { sayMobileNativeChatSubagentGroup as say } from './native-chat-subagent-group-copy'
import { sayMobileNativeChatSessionOption as sayOption } from '../../input/session-options/native-chat-session-option-copy'
import { normalizeSubagentState } from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import {
  subagentEntryDetail,
  subagentEntryRunsOn
} from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-entry-detail'
import { formatNativeChatDuration } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import type {
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
} from '../../../../../../src/shared/native-chat/native-chat-types'
import { useNow } from '../../../../hooks/use-now'
import { colors, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatRowOverlaysContext } from '../message-actions/mobile-native-chat-row-overlays'

export function stateDotStyle(state: NativeChatSubagentState): ViewStyle {
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
export function Elapsed({
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
  const t = useMobileTranslation()
  const { openSubagent } = useContext(MobileNativeChatRowOverlaysContext)
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
            const detail = [subagentEntryRunsOn(agent, sayOption), subagentEntryDetail(agent)]
              .filter((part): part is string => part !== null)
              .join(' · ')
            return (
              // Each entry opens its subagent's own view, where the chat can show one.
              <Pressable
                key={agent.id}
                testID="subagent-group-entry"
                disabled={!openSubagent}
                accessibilityRole={openSubagent ? 'button' : undefined}
                accessibilityLabel={
                  openSubagent
                    ? t('chat.subagentGroup.openAgent', 'Open {{value0}}', { value0: agent.label })
                    : undefined
                }
                style={({ pressed }) => [
                  styles.entryBlock,
                  openSubagent && styles.entryOpens,
                  pressed && styles.pressed
                ]}
                onPress={() => openSubagent?.(agent.id)}
              >
                <View style={styles.entry}>
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
                  {openSubagent ? (
                    <ChevronRight size={12} color={colors.textMuted} strokeWidth={2} />
                  ) : null}
                </View>
                {detail ? (
                  <Text style={styles.entryDetail} numberOfLines={2}>
                    {detail}
                  </Text>
                ) : null}
              </Pressable>
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
    borderRadius: radii.pill
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
  entryBlock: {
    paddingLeft: spacing.lg + spacing.xs
  },
  // A tap target, not just a line: room above and below the row it opens.
  entryOpens: {
    paddingVertical: spacing.xs
  },
  entry: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  // Aligns under the label, past the 6pt dot and its gap.
  entryDetail: {
    paddingLeft: 6 + spacing.sm,
    color: colors.textMuted,
    fontSize: typography.metaSize
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
