import { ChevronRight } from 'lucide-react-native'
import { Fragment } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { AgentSpinner, agentStatusColors } from '../components/AgentSpinner'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostDisplay } from '../transport/use-host-display'
import type { HostCatalogEntry } from '../transport/types'
import type { HomeJumpBackInRow } from '../worktree/home-jump-back-in'
import { agentStateLabel, formatTimeAgo, type AgentDotState } from '../worktree/agent-row-display'
import { homeListStyles as styles } from './home-list-styles'

const LABEL_STATE: Partial<Record<WorktreeStatus, AgentDotState>> = {
  permission: 'waiting',
  failed: 'failed',
  done: 'done',
  working: 'working',
  monitoring: 'monitoring'
}

// Only states that ask something of the user take the dot's colour; running work stays quiet.
const TINTED_STATUSES: ReadonlySet<WorktreeStatus> = new Set(['permission', 'failed', 'done'])

export function MobileHomeJumpBackIn(props: {
  rows: readonly HomeJumpBackInRow[]
  hosts: readonly HostCatalogEntry[]
  onOpen: (row: HomeJumpBackInRow) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const now = useNow()
  if (props.rows.length === 0) {
    return null
  }
  // One desktop needs no naming; the repo says more.
  const nameDesktops = props.hosts.length > 1
  return (
    <>
      <Text style={[styles.sectionHeading, styles.firstSectionHeading]} accessibilityRole="header">
        {t('home.jumpBackIn.heading', 'Jump back in')}
      </Text>
      <View style={styles.group}>
        {props.rows.map((row, index) => (
          <Fragment key={`${row.hostId}:${row.worktree.worktreeId}`}>
            {index > 0 ? <View style={styles.separator} /> : null}
            <JumpBackInRow
              row={row}
              host={props.hosts.find((host) => host.id === row.hostId) ?? null}
              nameDesktop={nameDesktops}
              now={now}
              onOpen={props.onOpen}
            />
          </Fragment>
        ))}
      </View>
    </>
  )
}

function JumpBackInRow(props: {
  row: HomeJumpBackInRow
  host: HostCatalogEntry | null
  nameDesktop: boolean
  now: number
  onOpen: (row: HomeJumpBackInRow) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { row } = props
  const desktopName = useHostDisplay(props.host).title
  const name = row.worktree.displayName || row.worktree.repo
  const labelState = LABEL_STATE[row.worktree.dotStatus]
  const status = row.lastOpened
    ? row.actionable
      ? t('home.jumpBackIn.lastOpened', 'Last opened')
      : t('home.jumpBackIn.connectToOpen', 'Connect {{desktop}} to open', { desktop: desktopName })
    : labelState
      ? agentStateLabel(labelState)
      : ''
  const where = props.nameDesktop ? desktopName : row.worktree.repo
  const showWhere = Boolean(where) && (row.actionable || !row.lastOpened)
  const statusColor =
    !row.lastOpened && TINTED_STATUSES.has(row.worktree.dotStatus)
      ? agentStatusColors()[row.worktree.dotStatus]
      : colors.textSecondary
  const time =
    typeof row.worktree.lastOutputAt === 'number'
      ? formatTimeAgo(row.worktree.lastOutputAt, props.now)
      : null

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, status, showWhere ? where : null, time].filter(Boolean).join(', ')}
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
          {name}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          <Text style={{ color: statusColor }}>{status}</Text>
          {showWhere ? ` · ${where}` : ''}
        </Text>
      </View>
      <View style={styles.trailing}>
        {time ? <Text style={styles.time}>{time}</Text> : null}
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}
