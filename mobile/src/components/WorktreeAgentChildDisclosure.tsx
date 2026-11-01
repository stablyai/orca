import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, pressedStyle, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { AgentDotState } from '../worktree/agent-row-display'
import { AgentStateDot } from './AgentStateDot'
import { AGENT_ROW_INDENT_PER_DEPTH } from './WorktreeAgentRow'

// Grow the 14 pt controls toward 44 pt downward only: later siblings win hit tests, so top slop would steal taps from the row above.
const CHILD_TOGGLE_HIT_SLOP = { top: 0, bottom: 15, left: 8, right: 8 } as const
const IDLE_GROUP_HIT_SLOP = { top: 0, bottom: 15 } as const

type ChildToggleProps = {
  count: number
  expanded: boolean
  // Shown beside the collapsed count so hidden sub-agent work stays visible.
  signalState?: AgentDotState
  onToggle: () => void
}

export function WorktreeAgentChildToggle({
  count,
  expanded,
  signalState,
  onToggle
}: ChildToggleProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const label = expanded
    ? count === 1
      ? t('components.worktreeAgentList.hideChildAgents_one', 'Hide {{count}} child agent', {
          count
        })
      : t('components.worktreeAgentList.hideChildAgents_other', 'Hide {{count}} child agents', {
          count
        })
    : count === 1
      ? t('components.worktreeAgentList.showChildAgents_one', 'Show {{count}} child agent', {
          count
        })
      : t('components.worktreeAgentList.showChildAgents_other', 'Show {{count}} child agents', {
          count
        })
  return (
    <Pressable
      style={({ pressed }) => [styles.toggle, pressed && pressedStyle]}
      hitSlop={CHILD_TOGGLE_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      onPress={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      {expanded ? null : (
        <>
          {signalState ? <AgentStateDot state={signalState} /> : null}
          <Text style={styles.count}>+{count}</Text>
        </>
      )}
      {expanded ? (
        <ChevronDown size={12} color={colors.textMuted} />
      ) : (
        <ChevronRight size={12} color={colors.textMuted} />
      )}
    </Pressable>
  )
}

type IdleGroupProps = {
  count: number
  depth: number
  expanded: boolean
  onToggle: () => void
}

/** Idle children fold behind one quiet row so held-but-idle sub-agents don't crowd live work. */
export function WorktreeAgentIdleGroupRow({ count, depth, expanded, onToggle }: IdleGroupProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.idleRow,
        { paddingLeft: depth * AGENT_ROW_INDENT_PER_DEPTH },
        pressed && pressedStyle
      ]}
      hitSlop={IDLE_GROUP_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={
        expanded
          ? t('components.worktreeAgentList.hideIdleChildren', 'Hide {{count}} idle child agents', {
              count
            })
          : t('components.worktreeAgentList.showIdleChildren', 'Show {{count}} idle child agents', {
              count
            })
      }
      accessibilityState={{ expanded }}
      onPress={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <View style={styles.idleDot}>
        <AgentStateDot state="idle" />
      </View>
      <Text style={styles.idleLabel} numberOfLines={1}>
        {t('components.worktreeAgentList.idleChildCount', '{{count}} idle', { count })}
      </Text>
      {expanded ? (
        <ChevronDown size={12} color={colors.textMuted} />
      ) : (
        <ChevronRight size={12} color={colors.textMuted} />
      )}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  toggle: {
    height: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2
  },
  count: {
    fontSize: 10,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  idleRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 3
  },
  // Group header is meta, not an agent: dim it so it doesn't read as another row.
  idleDot: {
    opacity: 0.6
  },
  idleLabel: {
    fontSize: 11,
    color: colors.textMuted,
    opacity: 0.8
  }
}))
