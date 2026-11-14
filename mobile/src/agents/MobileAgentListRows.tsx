import { Bell, ChevronDown, ChevronRight, Eye, EyeOff, X } from 'lucide-react-native'
import { Fragment, memo, useCallback, useState } from 'react'
import { Alert, Pressable, Text, View } from 'react-native'
import { formatAgentTypeLabel } from '../../../src/shared/agent-status/presentation/agent-type-label'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { AgentSpinner, agentStatusColors } from '../components/AgentSpinner'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { SwipeRowActions } from '../components/SwipeRowActions'
import { HOME_ROW_TEXT_INSET, homeListStyles } from '../home/home-list-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerMediumImpact } from '../platform/haptics/haptics'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../host-catalog/host-profile'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import {
  agentStateLabel,
  formatTimeAgo,
  type AgentDotState
} from '../worktree/agent-lineage/agent-row-display'
import {
  isDisclosureOpen,
  toggleDisclosure
} from '../worktree/agent-lineage/agent-child-disclosure'
import { areStructurallyEqual } from '../worktree/catalog/structural-equality'
import type { AgentListSection } from './agent-list-model'
import { agentStatusGroup, type AgentListRow } from './agent-list-rows'
import { agentListPreview } from './agent-list-row-text'

// The Home rollup glyph is the list's size; this maps a per-agent state onto its palette.
const GLYPH_STATUS: Record<AgentDotState, WorktreeStatus> = {
  working: 'working',
  monitoring: 'monitoring',
  blocked: 'permission',
  waiting: 'permission',
  permission: 'permission',
  failed: 'failed',
  done: 'done',
  interrupted: 'interrupted',
  unconfirmed: 'unconfirmed',
  idle: 'inactive',
  unverifiable: 'inactive'
}

const WORKER_INDENT = 22
const TOGGLE_HIT_SLOP = { top: 10, bottom: 10, left: 12, right: 12 } as const

const workersKey = (row: AgentListRow) => `agents:workers:${row.key}`

type ShownRow = { row: AgentListRow; key: string; workersOpen?: boolean }

export type AgentListRowHandlers = Readonly<{
  onOpen: (row: AgentListRow) => void
  onLongPress: (row: AgentListRow) => void
  onSetRead: (rows: readonly AgentListRow[], read: boolean) => void
  onClear: (rows: readonly AgentListRow[]) => void
}>

/** One inset group of agent rows, with each coordinator's workers and an optional idle fold. */
export function MobileAgentListRows(props: {
  handlers: AgentListRowHandlers
  rows: readonly AgentListRow[]
  idleRows?: readonly AgentListRow[]
  footer: AgentListSection['footer']
  nameDesktop: boolean
  hosts: readonly HostProfile[]
  now: number
  /** Remembers the idle fold per list. */
  idleKey?: string
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Disclosures live in a module cache so they survive remounts; this only redraws after a toggle.
  const [, setRevision] = useState(0)
  const toggle = useCallback((key: string) => {
    toggleDisclosure(key)
    setRevision((revision) => revision + 1)
  }, [])
  const idleKey = `agents:idle:${props.idleKey ?? ''}`
  const idleOpen = isDisclosureOpen(idleKey)
  const idleRows = props.idleRows ?? []
  const hostById = new Map(props.hosts.map((host) => [host.id, host]))
  const withWorkers = (rows: readonly AgentListRow[], prefix: string) =>
    rows.flatMap((row): ShownRow[] => {
      const key = `${prefix}${row.key}`
      const workersOpen = row.workers.length > 0 ? isDisclosureOpen(workersKey(row)) : undefined
      const workers = workersOpen
        ? row.workers.map((worker) => ({ row: worker, key: `${key}>${worker.key}` }))
        : []
      return [{ row, key, workersOpen }, ...workers]
    })
  const renderRows = (items: readonly ShownRow[], separateFirst: boolean) =>
    items.map((item, index) => (
      <Fragment key={item.key}>
        {index > 0 || separateFirst ? (
          <View
            style={[
              homeListStyles.separator,
              { marginLeft: HOME_ROW_TEXT_INSET + item.row.depth * WORKER_INDENT }
            ]}
          />
        ) : null}
        <MobileAgentListRow
          row={item.row}
          host={hostById.get(item.row.hostId) ?? null}
          footer={props.footer}
          nameDesktop={props.nameDesktop}
          now={props.now}
          workersOpen={item.workersOpen}
          onToggleWorkers={toggle}
          handlers={props.handlers}
        />
      </Fragment>
    ))
  return (
    <View style={homeListStyles.group}>
      {renderRows(withWorkers(props.rows, ''), false)}
      {idleRows.length > 0 ? (
        <>
          {props.rows.length > 0 ? <View style={homeListStyles.separator} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: idleOpen }}
            style={({ pressed }) => [styles.foldRow, pressed && homeListStyles.rowPressed]}
            onPress={() => toggle(idleKey)}
          >
            {idleOpen ? (
              <ChevronDown size={15} color={colors.textMuted} />
            ) : (
              <ChevronRight size={15} color={colors.textMuted} />
            )}
            <Text style={styles.foldLabel}>
              {t('agents.list.idleCount', '{{count}} idle', { count: idleRows.length })}
            </Text>
          </Pressable>
          {idleOpen ? renderRows(withWorkers(idleRows, 'idle>'), true) : null}
        </>
      ) : null}
    </View>
  )
}

// Each refresh rebuilds every row; compare by value so only changed rows redraw.
const MobileAgentListRow = memo(function MobileAgentListRow(props: {
  handlers: AgentListRowHandlers
  row: AgentListRow
  host: HostProfile | null
  footer: AgentListSection['footer']
  nameDesktop: boolean
  now: number
  /** Undefined when the row has no workers to show. */
  workersOpen?: boolean
  onToggleWorkers: (key: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { row } = props
  const { agent } = row.entry
  const desktop = useHostDisplay(props.host).title
  const { title } = row
  const group = row.stale ? null : agentStatusGroup(row.dotState)
  const preview = agentListPreview(agent, group, title)
  const needsYou = group === 'needs-you'
  const stateWord = needsYou ? agentStateLabel(row.dotState) : ''
  const place = [
    props.footer === 'agent' ? formatAgentTypeLabel(agent.agentType) : row.entry.workspaceName,
    props.nameDesktop ? desktop : null
  ]
    .filter(Boolean)
    .join(' · ')
  const time = row.timeAt > 0 ? formatTimeAgo(row.timeAt, props.now) : ''
  const workerCount = row.workers.length
  const workersLabel =
    workerCount === 1
      ? t('agents.list.workers_one', '{{count}} worker', { count: workerCount })
      : t('agents.list.workers_other', '{{count}} workers', { count: workerCount })
  // The row is one accessibility element, so screen readers reach the workers toggle through it.
  const workersAction =
    props.workersOpen === undefined
      ? null
      : {
          name: 'toggleWorkers',
          label: props.workersOpen
            ? t('agents.list.hideWorkers', 'Hide {{workers}}', { workers: workersLabel })
            : t('agents.list.showWorkers', 'Show {{workers}}', { workers: workersLabel })
        }
  const longPress = () => {
    triggerMediumImpact()
    props.handlers.onLongPress(row)
  }
  const open = () => {
    if (row.offline) {
      Alert.alert(
        t('agents.list.offlineTitle', '{{desktop}} is offline', { desktop }),
        t('agents.list.offlineMessage', 'Reconnect it to open this agent.')
      )
      return
    }
    props.handlers.onOpen(row)
  }
  const actionsLabel = t('agents.list.actions', 'Actions for {{title}}', { title })
  const unread = row.unread === true
  return (
    <SwipeRowActions
      leading={
        row.unread === undefined || row.offline
          ? undefined
          : {
              label: unread ? t('agents.swipe.read', 'Read') : t('agents.swipe.unread', 'Unread'),
              accessibilityLabel: unread
                ? t('agents.actions.markRead', 'Mark as read')
                : t('agents.actions.markUnread', 'Mark as unread'),
              icon: unread ? Eye : EyeOff,
              background: colors.accentBlue,
              foreground: colors.onAccent,
              onPress: () => props.handlers.onSetRead([row], unread)
            }
      }
      trailing={
        row.clearable && !row.offline
          ? {
              label: t('agents.swipe.clear', 'Clear'),
              accessibilityLabel: t('agents.actions.clear', 'Clear from list'),
              icon: X,
              background: colors.textMuted,
              foreground: colors.onAccent,
              onPress: () => props.handlers.onClear([row])
            }
          : undefined
      }
    >
      {(guardPress) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[
            title,
            unread ? t('agents.list.unread', 'Unread') : null,
            stateWord || null,
            preview || null,
            place,
            time,
            workersAction ? workersLabel : null
          ]
            .filter(Boolean)
            .join(', ')}
          accessibilityState={
            props.workersOpen === undefined ? undefined : { expanded: props.workersOpen }
          }
          accessibilityActions={[
            { name: 'longpress', label: actionsLabel },
            ...(workersAction ? [workersAction] : [])
          ]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'longpress') {
              longPress()
            } else if (event.nativeEvent.actionName === 'toggleWorkers') {
              props.onToggleWorkers(workersKey(row))
            }
          }}
          style={({ pressed }) => [
            homeListStyles.row,
            styles.row,
            row.depth > 0 && { paddingLeft: spacing.lg + row.depth * WORKER_INDENT },
            pressed && homeListStyles.rowPressed
          ]}
          onPress={guardPress(open)}
          onLongPress={longPress}
          delayLongPress={400}
        >
          <View style={[homeListStyles.status, row.stale && homeListStyles.rowDisabled]}>
            <AgentSpinner status={GLYPH_STATUS[row.dotState]} />
          </View>
          <View style={[styles.text, row.stale && homeListStyles.rowDisabled]}>
            <View style={styles.titleLine}>
              <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={1}>
                {title}
              </Text>
              {time ? <Text style={styles.time}>{time}</Text> : null}
            </View>
            {stateWord || preview ? (
              <Text style={styles.preview} numberOfLines={2}>
                {stateWord ? (
                  <Text style={[styles.stateWord, { color: agentStatusColors().permission }]}>
                    {stateWord}
                  </Text>
                ) : null}
                {stateWord && preview ? ' · ' : ''}
                {preview}
              </Text>
            ) : null}
            <View style={styles.footer}>
              {agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={13} /> : null}
              <Text style={styles.place} numberOfLines={1}>
                {place}
              </Text>
              <View style={styles.trailing}>
                {unread ? (
                  <Bell size={12} color={colors.statusAmber} fill={colors.statusAmber} />
                ) : null}
                {props.workersOpen !== undefined ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: props.workersOpen }}
                    hitSlop={TOGGLE_HIT_SLOP}
                    style={styles.workers}
                    onPress={(event) => {
                      event.stopPropagation()
                      guardPress(() => props.onToggleWorkers(workersKey(row)))()
                    }}
                  >
                    {props.workersOpen ? (
                      <ChevronDown size={13} color={colors.textSecondary} />
                    ) : (
                      <ChevronRight size={13} color={colors.textSecondary} />
                    )}
                    <Text style={styles.workersLabel}>{workersLabel}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>
        </Pressable>
      )}
    </SwipeRowActions>
  )
}, areStructurallyEqual)

const styles = themedStyleSheet(() => ({
  text: { flex: 1, minWidth: 0, paddingTop: 9, paddingBottom: 10, paddingRight: 14, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  // Opaque so a swipe's actions stay hidden until the row slides off them.
  row: { backgroundColor: colors.bgPanel },
  title: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: colors.textPrimary },
  titleUnread: { fontWeight: '600' },
  time: { fontSize: 12, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  preview: { fontSize: 14, lineHeight: 19, color: colors.textSecondary },
  stateWord: { fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  place: { flexShrink: 1, fontSize: 12, color: colors.textMuted },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  workers: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  workersLabel: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  foldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingLeft: HOME_ROW_TEXT_INSET - 4,
    paddingRight: spacing.lg
  },
  foldLabel: { fontSize: 14, color: colors.textSecondary }
}))
