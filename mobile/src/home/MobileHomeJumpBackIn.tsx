import { ChevronRight } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { AgentSpinner, agentStatusColors } from '../components/AgentSpinner'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostDisplay } from '../transport/use-host-display'
import type { HostCatalogEntry } from '../transport/types'
import type { HomeJumpBackInRow } from '../worktree/home-jump-back-in'
import { agentStateLabel, type AgentDotState } from '../worktree/agent-row-display'
import { homeListStyles as styles } from './home-list-styles'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'
import { HOME_EASE_OUT } from './tabs/home-tabs'

const LABEL_STATE: Partial<Record<WorktreeStatus, AgentDotState>> = {
  permission: 'waiting',
  failed: 'failed',
  done: 'done',
  working: 'working',
  monitoring: 'monitoring'
}

// Only states that ask something of the user take the dot's colour; running work stays quiet.
const TINTED_STATUSES: ReadonlySet<WorktreeStatus> = new Set(['permission', 'failed', 'done'])

// Enough to see what needs you without the list pushing Desktops off the first screen.
const AGENT_ROWS_COLLAPSED = 5

export function MobileHomeJumpBackIn(props: {
  rows: readonly HomeJumpBackInRow[]
  hosts: readonly HostCatalogEntry[]
  first: boolean
  onOpen: (row: HomeJumpBackInRow) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const reducedMotion = useReducedMotionEnabled() === true
  const [expanded, setExpanded] = useState(false)
  if (props.rows.length === 0) {
    return null
  }
  // One desktop needs no naming.
  const nameDesktops = props.hosts.length > 1
  const collapsible = props.rows.length > AGENT_ROWS_COLLAPSED
  const shown = expanded || !collapsible ? props.rows : props.rows.slice(0, AGENT_ROWS_COLLAPSED)
  const activeCount = props.rows.filter((row) => !row.lastOpened).length
  // Rows glide to their new place when an agent's state reorders the list.
  const layout = reducedMotion ? undefined : LinearTransition.duration(220).easing(HOME_EASE_OUT)
  const entering = reducedMotion ? undefined : FadeIn.duration(180)
  return (
    <>
      <MobileHomeSectionHeading
        title={t('home.agents.heading', 'Agents')}
        aside={
          activeCount > 0
            ? t('home.agents.activeCount', '{{count}} active', { count: activeCount })
            : undefined
        }
        first={props.first}
      />
      <Animated.View style={styles.group} layout={layout}>
        {shown.map((row, index) => (
          <Animated.View
            key={`${row.hostId}:${row.worktree.worktreeId}`}
            layout={layout}
            entering={entering}
            exiting={reducedMotion ? undefined : FadeOut.duration(120)}
          >
            {index > 0 ? <View style={styles.separator} /> : null}
            <JumpBackInRow
              row={row}
              host={props.hosts.find((host) => host.id === row.hostId) ?? null}
              nameDesktop={nameDesktops}
              onOpen={props.onOpen}
            />
          </Animated.View>
        ))}
        {collapsible ? (
          <Animated.View layout={layout}>
            <View style={[styles.separator, styles.fullSeparator]} />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
              onPress={() => setExpanded((value) => !value)}
            >
              <Text style={[styles.actionLabel, { color: colors.textSecondary }]}>
                {expanded
                  ? t('home.agents.showFewer', 'Show fewer')
                  : t('home.agents.showAll', 'Show all {{count}}', { count: props.rows.length })}
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </Animated.View>
    </>
  )
}

function JumpBackInRow(props: {
  row: HomeJumpBackInRow
  host: HostCatalogEntry | null
  nameDesktop: boolean
  onOpen: (row: HomeJumpBackInRow) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { row } = props
  const desktopName = useHostDisplay(props.host).title
  const workspace = row.worktree.displayName || row.worktree.repo
  const conversation = row.worktree.conversationName
  const title = conversation ?? workspace
  const labelState = LABEL_STATE[row.worktree.dotStatus]
  const status = row.lastOpened
    ? row.actionable
      ? t('home.jumpBackIn.lastOpened', 'Last opened')
      : t('home.jumpBackIn.connectToOpen', 'Connect {{desktop}} to open', { desktop: desktopName })
    : labelState
      ? agentStateLabel(labelState)
      : ''
  // Branch names repeat across projects, so the repo is always named (#37642); "Connect X" already names the desktop.
  // A named conversation takes the title and moves the workspace to the subtitle (#38007).
  const where = [
    conversation ? workspace : null,
    row.worktree.repo && row.worktree.repo !== workspace ? row.worktree.repo : null,
    props.nameDesktop && (row.actionable || !row.lastOpened) ? desktopName : null
  ]
    .filter(Boolean)
    .join(' · ')
  const statusColor =
    !row.lastOpened && TINTED_STATUSES.has(row.worktree.dotStatus)
      ? agentStatusColors()[row.worktree.dotStatus]
      : colors.textSecondary

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, status, where].filter(Boolean).join(', ')}
      accessibilityState={{ disabled: !row.actionable }}
      disabled={!row.actionable}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => props.onOpen(row)}
    >
      <View style={[styles.status, !row.actionable && styles.rowDisabled]}>
        <AgentSpinner status={row.worktree.dotStatus} workingMode={row.worktree.workingMode} />
      </View>
      <View style={[styles.text, !row.actionable && styles.rowDisabled]}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          <Text style={{ color: statusColor }}>{status}</Text>
          {where ? `${status ? ' · ' : ''}${where}` : ''}
        </Text>
      </View>
      <View style={styles.trailing}>
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}
