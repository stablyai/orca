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
  blocked: '#ef4444',
  waiting: '#ef4444',
  interrupted: colors.textMuted,
  failed: '#ef4444',
  unconfirmed: colors.statusAmber,
  idle: 'rgba(115,115,115,0.4)'
}
export const AGENT_WORKING_COLOR = '#eab308'

/** `unverifiable` is a child row's lost contact: desktop's dashed amber ring, a missing-evidence
 *  mark rather than a state claim. */
export function AgentStateDot({ state }: { state: AgentDotState | 'unverifiable' }) {
  const rotate = useWorkingRingRotation(state === 'working')

  if (state === 'working') {
    return (
      <View style={styles.wrapper}>
        <Animated.View style={[styles.spinner, { transform: [{ rotate }] }]} />
      </View>
    )
  }

  if (state === 'monitoring') {
    return (
      <View style={styles.wrapper} accessibilityLabel="Monitoring background tasks">
        <Activity size={10} color={AGENT_WORKING_COLOR} />
      </View>
    )
  }

  if (state === 'unverifiable') {
    return (
      <View style={styles.wrapper} accessibilityLabel="No recent update">
        <View style={styles.dashedRing} />
      </View>
    )
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.dot, { backgroundColor: DOT_COLORS[state] }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
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
