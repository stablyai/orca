import { Activity } from 'lucide-react-native'
import { Animated, StyleSheet, View } from 'react-native'
import type { AgentDotState } from '../worktree/agent-row-display'
import { colors } from '../theme/mobile-theme'
import { useWorkingRingRotation } from './use-working-ring-rotation'

// Per-agent state indicator, 1:1 with desktop AgentStateDot
// (src/renderer/src/components/AgentStateDot.tsx): yellow spinner for 'working',
// emerald for 'done', red for blocked/waiting/failed (attention), muted for a user's Stop
// ('interrupted'), amber for 'unconfirmed' (desktop's missing-evidence tone), neutral for idle. Distinct from the
// worktree-level AgentSpinner, which collapses the agent vocabulary into the 5-state
// rollup the sidebar dot uses.
const DOT_COLORS: Record<Exclude<AgentDotState, 'working' | 'monitoring'>, string> = {
  done: '#10b981',
  blocked: colors.statusRed,
  waiting: colors.statusRed,
  interrupted: colors.textMuted,
  failed: colors.statusRed,
  unconfirmed: colors.statusAmber,
  idle: 'rgba(115,115,115,0.4)'
}
export const AGENT_WORKING_COLOR = '#eab308'

/** `unverifiable` is a child row's lost contact: desktop's dashed amber ring, a missing-evidence
 *  mark rather than a state claim. */
export function AgentStateDot({
  state,
  size = 'small'
}: {
  state: AgentDotState | 'unverifiable'
  /** `regular` sits beside 14 pt text, as on the worktree list. */
  size?: 'small' | 'regular'
}) {
  const rotate = useWorkingRingRotation(state === 'working')
  const regular = size === 'regular'
  const wrapper = [styles.wrapper, regular && styles.wrapperRegular]

  if (state === 'working') {
    return (
      <View style={wrapper}>
        <Animated.View
          style={[styles.spinner, regular && styles.spinnerRegular, { transform: [{ rotate }] }]}
        />
      </View>
    )
  }

  if (state === 'monitoring') {
    return (
      <View style={wrapper} accessibilityLabel="Monitoring background tasks">
        <Activity size={regular ? 13 : 10} color={AGENT_WORKING_COLOR} />
      </View>
    )
  }

  if (state === 'unverifiable') {
    return (
      <View style={wrapper} accessibilityLabel="No recent update">
        <View style={[styles.dashedRing, regular && styles.ringRegular]} />
      </View>
    )
  }

  return (
    <View style={wrapper}>
      <View
        style={[styles.dot, regular && styles.dotRegular, { backgroundColor: DOT_COLORS[state] }]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: {
    width: 10,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  wrapperRegular: { width: 14, height: 14 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotRegular: { width: 8, height: 8, borderRadius: 4 },
  ringRegular: { width: 10, height: 10, borderRadius: 5 },
  spinnerRegular: { width: 9, height: 9, borderRadius: 4.5, borderWidth: 2 },
  dashedRing: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.statusAmber
  },
  spinner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: AGENT_WORKING_COLOR,
    borderTopColor: 'transparent'
  }
})
