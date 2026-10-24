import { Activity } from 'lucide-react-native'
import { StyleSheet, View } from 'react-native'
import type { AgentWorkingMode } from '../../../src/shared/agent-status-types'

type WorktreeStatus = 'working' | 'active' | 'permission' | 'done' | 'inactive'

// Why: colors and sizing are 1:1 with the desktop StatusIndicator
// (src/renderer/src/components/sidebar/StatusIndicator.tsx) so the mobile
// worktree list reads identically to the sidebar — same yellow ring for
// 'working', same emerald dot for 'active'/'done', same neutral-500 @ 40%
// for 'inactive', same red for 'permission'. Diverging palettes here lose
// the design intent ('moving' vs 'alive' vs 'completed') the desktop encodes.
const STATUS_COLORS: Record<WorktreeStatus, string> = {
  working: '#eab308',
  active: '#10b981',
  done: '#10b981',
  permission: '#ef4444',
  inactive: 'rgba(115,115,115,0.4)'
}

export function AgentSpinner({
  status,
  workingMode
}: {
  status: WorktreeStatus
  workingMode?: AgentWorkingMode
}) {
  const monitoring = status === 'working' && workingMode === 'monitoring'
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.inactive

  if (monitoring) {
    return (
      <View style={styles.wrapper} accessibilityLabel="Monitoring background tasks">
        <Activity size={12} color={STATUS_COLORS.working} />
      </View>
    )
  }

  if (status === 'working') {
    return (
      <View style={styles.wrapper}>
        <View style={[styles.spinner, { borderColor: color }]} />
      </View>
    )
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  // Why: 12x12 wrapper centered around an 8x8 inner glyph mirrors the
  // desktop's `inline-flex h-3 w-3 ... items-center justify-center` shell
  // around `size-2` indicator — keeps row height/baseline alignment stable
  // across status transitions.
  wrapper: {
    width: 12,
    height: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  spinner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
    borderTopColor: 'transparent',
    transform: [{ rotate: '225deg' }]
  }
})
