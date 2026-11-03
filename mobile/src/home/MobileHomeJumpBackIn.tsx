import { ChevronRight } from 'lucide-react-native'
import { Fragment } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { AgentSpinner, agentStatusColors } from '../components/AgentSpinner'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostDisplay } from '../transport/use-host-display'
import type { HostCatalogEntry } from '../transport/types'
import type { HomeJumpBackInRow } from '../worktree/home-jump-back-in'
import { agentStateLabel, type AgentDotState } from '../worktree/agent-row-display'
import { homeListStyles as styles } from './home-list-styles'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'

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
  first: boolean
  onOpen: (row: HomeJumpBackInRow) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  if (props.rows.length === 0) {
    return null
  }
  // One desktop needs no naming.
  const nameDesktops = props.hosts.length > 1
  return (
    <>
      <MobileHomeSectionHeading
        title={t('home.jumpBackIn.heading', 'Jump back in')}
        first={props.first}
      />
      <View style={styles.group}>
        {props.rows.map((row, index) => (
          <Fragment key={`${row.hostId}:${row.worktree.worktreeId}`}>
            {index > 0 ? <View style={styles.separator} /> : null}
            <JumpBackInRow
              row={row}
              host={props.hosts.find((host) => host.id === row.hostId) ?? null}
              nameDesktop={nameDesktops}
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
