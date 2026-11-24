import { Activity, MessageCircleQuestion } from 'lucide-react-native'
import { Animated, View, type ViewStyle } from 'react-native'
import { agentStateLabel, type AgentDotState } from '../../worktree/agent-lineage/agent-row-display'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { useWorkingRingRotation } from '../../components/motion/use-working-motion'

/** A waiting, permission or failure dot. */
export const AGENT_ATTENTION_COLOR = '#ef4444'

const dotColors = (): Record<
  Exclude<AgentDotState, 'working' | 'monitoring' | 'blocked' | 'unverifiable'>,
  string
> => ({
  done: '#10b981',
  waiting: AGENT_ATTENTION_COLOR,
  permission: AGENT_ATTENTION_COLOR,
  interrupted: colors.textMuted,
  failed: AGENT_ATTENTION_COLOR,
  unconfirmed: colors.statusAmber,
  idle: 'rgba(115,115,115,0.4)'
})
export const AGENT_WORKING_COLOR = '#eab308'
/** The dot's box, so rows can line text up past it. */
export const AGENT_STATE_DOT_SIZE = 10

/** Spins only while mounted, so idle rows hold no loop; Reduce Motion closes the gap, as desktop does. */
export function WorkingRing({ color, style }: { color: string; style: ViewStyle }) {
  // Unknown counts as reduced, the same as LoadingSpinner.
  const still = useReducedMotionEnabled() !== false
  const ring = useWorkingRingRotation(!still)
  return (
    <Animated.View
      ref={ring.ref}
      // One object, sides after the shorthand: react-native-web lets a later borderColor repaint the gap.
      style={[
        style,
        { borderColor: color, borderTopColor: still ? color : 'transparent' },
        still ? undefined : ring.style
      ]}
    />
  )
}

/** `unverifiable` is a child row's lost contact: desktop's dashed amber ring, a missing-evidence
 *  mark rather than a state claim. */
export function AgentStateDot({ state }: { state: AgentDotState | 'unverifiable' }) {
  const t = useMobileTranslation()
  useMobileColorScheme()

  if (state === 'working') {
    return (
      <View style={styles.wrapper}>
        <WorkingRing color={AGENT_WORKING_COLOR} style={styles.spinner} />
      </View>
    )
  }

  if (state === 'monitoring') {
    return (
      <View
        style={styles.wrapper}
        accessibilityLabel={t('components.agentStateDot.monitoring', 'Monitoring background tasks')}
      >
        <Activity size={10} color={AGENT_WORKING_COLOR} />
      </View>
    )
  }

  if (state === 'unverifiable') {
    return (
      <View
        style={styles.wrapper}
        accessibilityLabel={t('components.agentStateDot.unverifiable', 'No recent update')}
      >
        <View style={styles.dashedRing} />
      </View>
    )
  }

  if (state === 'blocked') {
    return (
      <View style={styles.wrapper} accessibilityLabel={agentStateLabel(state)}>
        <MessageCircleQuestion size={AGENT_STATE_DOT_SIZE} color={colors.agentQuestion} />
      </View>
    )
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.dot, { backgroundColor: dotColors()[state] }]} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  wrapper: {
    width: AGENT_STATE_DOT_SIZE,
    height: AGENT_STATE_DOT_SIZE,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dot: { width: 6, height: 6, borderRadius: radii.pill },
  dashedRing: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.statusAmber
  },
  spinner: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    borderWidth: 1.5
  }
}))
