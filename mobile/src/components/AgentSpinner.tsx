import { Activity } from 'lucide-react-native'
import { Animated, View } from 'react-native'
import type { AgentWorkingMode } from '../../../src/shared/agent-status-types'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useWorkingRingRotation } from './use-working-ring-rotation'

// Match desktop sidebar StatusIndicator colors/sizes for the worktree rollup; palette distinguishes moving/alive/completed states.
export const agentStatusColors = (): Record<WorktreeStatus, string> => ({
  working: '#eab308',
  monitoring: '#eab308',
  active: '#10b981',
  done: '#10b981',
  permission: '#ef4444',
  failed: '#ef4444',
  interrupted: colors.textMuted,
  unconfirmed: colors.statusAmber,
  inactive: 'rgba(115,115,115,0.4)'
})

export function AgentSpinner({
  status,
  workingMode
}: {
  status: WorktreeStatus
  workingMode?: AgentWorkingMode
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const monitoring =
    status === 'monitoring' || (status === 'working' && workingMode === 'monitoring')
  const rotate = useWorkingRingRotation(status === 'working' && !monitoring)

  const palette = agentStatusColors()
  const color = palette[status] ?? palette.inactive

  if (monitoring) {
    return (
      <View
        style={styles.wrapper}
        accessibilityLabel={t('components.agentSpinner.monitoring', 'Monitoring background tasks')}
      >
        <Activity size={12} color={palette.working} />
      </View>
    )
  }

  if (status === 'unconfirmed') {
    return (
      <View
        style={styles.wrapper}
        accessibilityLabel={t('components.agentSpinner.unconfirmed', 'Couldn’t confirm')}
      >
        <View style={styles.dashedRing} />
      </View>
    )
  }

  if (status === 'working') {
    return (
      <View style={styles.wrapper}>
        <Animated.View style={[styles.spinner, { borderColor: color, transform: [{ rotate }] }]} />
      </View>
    )
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // Match desktop 12px shell/8px glyph so row baseline remains stable through status transitions.
  wrapper: {
    width: 12,
    height: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill
  },
  dashedRing: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: agentStatusColors().unconfirmed
  },
  spinner: {
    width: 8,
    height: 8,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderTopColor: 'transparent'
  }
}))
