import { useState } from 'react'
import { Activity, Moon } from 'lucide-react-native'
import { View } from 'react-native'
import type { AgentWorkingMode } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import type { WorktreeStatus } from '../../../../src/shared/worktree/row-display/worktree-status-rollup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { ArrivalFade } from '../../components/motion/ArrivalFade'
import { agentStateLabel } from '../../worktree/agent-lineage/agent-row-display'
import { AGENT_FAILURE_COLOR, AgentQuestionIcon, WorkingRing } from './AgentStateDot'

const STATUS_SLOT_SIZE = 12

export type AgentSpinnerStatus = WorktreeStatus | 'blocked' | 'waiting'

// Match desktop sidebar StatusIndicator colors/sizes for the worktree rollup; palette distinguishes moving/alive/completed states.
const agentStatusColors = (): Record<Exclude<WorktreeStatus, 'permission'>, string> => ({
  working: '#eab308',
  monitoring: '#eab308',
  active: '#10b981',
  done: '#10b981',
  failed: AGENT_FAILURE_COLOR,
  interrupted: colors.textMuted,
  unconfirmed: colors.statusAmber,
  inactive: 'rgba(115,115,115,0.4)'
})

// Sleeping replaces quiet states only; attention/running states keep their own glyph.
const QUIET_SLEEP_REPLACEABLE_STATUSES: ReadonlySet<WorktreeStatus> = new Set([
  'active',
  'done',
  'inactive'
])

/** `status` null is a state not known yet (rows from the phone's store): the slot keeps its width, empty. */
export function AgentSpinner({
  status,
  workingMode,
  sleeping = false
}: {
  status: AgentSpinnerStatus | null
  workingMode?: AgentWorkingMode
  sleeping?: boolean
}) {
  const [startedEmpty] = useState(status === null)
  if (startedEmpty) {
    return <ArrivingAgentStatus status={status} workingMode={workingMode} sleeping={sleeping} />
  }
  return status === null ? (
    <View style={styles.wrapper} />
  ) : (
    <AgentStatusGlyph status={status} workingMode={workingMode} sleeping={sleeping} />
  )
}

// Mounted with the empty slot, so the motion preference is read before the dot arrives and fades in.
function ArrivingAgentStatus({
  status,
  workingMode,
  sleeping
}: {
  status: AgentSpinnerStatus | null
  workingMode?: AgentWorkingMode
  sleeping: boolean
}) {
  const reducedMotion = useReducedMotionEnabled()
  if (status === null) {
    return <View style={styles.wrapper} />
  }
  return (
    <ArrivalFade animate={reducedMotion === false}>
      <AgentStatusGlyph status={status} workingMode={workingMode} sleeping={sleeping} />
    </ArrivalFade>
  )
}

function AgentStatusGlyph({
  status,
  workingMode,
  sleeping
}: {
  status: AgentSpinnerStatus
  workingMode?: AgentWorkingMode
  sleeping: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  if (status === 'blocked' || status === 'waiting' || status === 'permission') {
    return (
      <View accessible style={styles.wrapper} accessibilityLabel={agentStateLabel(status)}>
        <AgentQuestionIcon size={STATUS_SLOT_SIZE} />
      </View>
    )
  }

  const monitoring =
    status === 'monitoring' || (status === 'working' && workingMode === 'monitoring')

  const palette = agentStatusColors()
  const color = palette[status] ?? palette.inactive

  if (monitoring) {
    return (
      <View
        accessible
        style={styles.wrapper}
        accessibilityLabel={t('components.agentSpinner.monitoring', 'Monitoring background tasks')}
      >
        <Activity size={STATUS_SLOT_SIZE} color={palette.working} />
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
        <WorkingRing color={color} style={styles.spinner} />
      </View>
    )
  }

  if (sleeping && QUIET_SLEEP_REPLACEABLE_STATUSES.has(status)) {
    return (
      <View
        style={styles.wrapper}
        accessibilityLabel={t('components.agentSpinner.sleeping', 'Sleeping')}
      >
        <Moon size={12} color={colors.textMuted} />
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
    width: STATUS_SLOT_SIZE,
    height: STATUS_SLOT_SIZE,
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
    borderWidth: 2
  }
}))
