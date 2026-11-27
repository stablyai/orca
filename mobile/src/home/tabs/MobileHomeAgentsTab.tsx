import { CheckCheck, Ellipsis, SquareTerminal, Trash2, WifiOff } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  View,
  type HostInstance
} from 'react-native'
import {
  agentListRowsIn,
  buildAgentList,
  DEFAULT_AGENT_LIST_VIEW,
  type AgentListSection
} from '../../agents/agent-list-model'
import { loadAgentListView, saveAgentListView } from '../../agents/agent-list-preferences'
import { MobileAgentListRows, type AgentListRowHandlers } from '../../agents/MobileAgentListRows'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { useSerializedStoredState } from '../../storage/use-serialized-stored-state'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { HostProfile } from '../../host-catalog/host-profile'
import { useHostDisplay } from '../../host-descriptors/use-host-display'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import { homeListStyles } from '../home-list-styles'
import { MobileHomeSectionHeading } from '../MobileHomeSectionHeading'
import type { MobileHomeData } from '../use-mobile-home-data'
import { MobileHomeAgentsBottomBar } from './MobileHomeAgentsBottomBar'
import { MobileHomeTabEmpty } from './MobileHomeTabEmpty'
import { MobileHomeTabHeader, MobileHomeTabHeaderButton } from './MobileHomeTabHeader'

/** Every agent on every paired computer, grouped the way the user picked. */
export function MobileHomeAgentsTab(props: {
  data: MobileHomeData
  handlers: AgentListRowHandlers
  /** The tab is showing; a hidden tab keeps its list but drops its bar. */
  active: boolean
  /** What the bar and keyboard cover, for Home's toasts. */
  onBarHeightChange: (height: number) => void
  /** Absent while no computer is connected to start one on. */
  onNewWorkspace?: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { data } = props
  const hosts = data.sortedHosts
  const stored = useSerializedStoredState(
    DEFAULT_AGENT_LIST_VIEW,
    loadAgentListView,
    saveAgentListView
  )
  const { refresh } = stored
  useEffect(() => refresh(), [refresh])
  const view = stored.value
  const [query, setQuery] = useState('')
  const [pickedHost, setPickedHost] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [barHeight, setBarHeight] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const moreRef = useRef<HostInstance>(null)
  const { onBarHeightChange } = props
  const onBarHeight = useCallback(
    (height: number) => {
      setBarHeight(height)
      onBarHeightChange(height)
    },
    [onBarHeightChange]
  )
  // An unpaired computer's filter falls back to every computer.
  const hostFilter = hosts.some((host) => host.id === pickedHost) ? pickedHost : null
  const { now } = data.agentList
  const list = useMemo(
    () => buildAgentList(data.agentList, { view, hostFilter, query }),
    [data.agentList, view, hostFilter, query]
  )
  const nameDesktops = hosts.length > 1 && hostFilter === null
  const listed = useMemo(() => agentListRowsIn(list.sections), [list.sections])
  const unreadRows = listed.filter((row) => row.unread === true)
  const clearableRows = listed.filter((row) => row.clearable)
  const clearFinished = () => props.handlers.onClear(clearableRows)
  // The Done heading's Clear acts on Done alone; a failed agent under Needs you stays.
  const clearSection = (section: AgentListSection) => {
    const rows = agentListRowsIn([section]).filter((row) => row.clearable)
    return rows.length > 0 ? () => props.handlers.onClear(rows) : undefined
  }
  const pullToRefresh = () => {
    setRefreshing(true)
    void data.refreshAgents().finally(() => setRefreshing(false))
  }
  const setView = (next: typeof view) => {
    stored.setValue(next)
    stored.persist(next)
  }

  const menuGroups: ActionSheetAction[][] = [
    [
      {
        id: 'mark-all-read',
        label: t('agents.options.markAllRead', 'Mark all read'),
        icon: CheckCheck,
        disabled: unreadRows.length === 0,
        onPress: () => props.handlers.onSetRead(unreadRows, true)
      },
      {
        id: 'clear-finished',
        label: t('agents.options.clearFinished', 'Clear finished'),
        icon: Trash2,
        disabled: clearableRows.length === 0,
        onPress: clearFinished
      }
    ]
  ]

  const filteredHosts = hosts.filter((host) => hostFilter === null || host.id === hostFilter)
  // A computer still dialing, or connected with its first list read pending, may yet have agents.
  const awaitingDesktop = filteredHosts.some((host) =>
    data.hostStates[host.id] === 'connected'
      ? !data.worktreeInfo[host.id]?.catalogUnavailable
      : !data.unreachableHosts.has(host.id)
  )
  const emptyState = (): ReactNode => {
    const trimmed = query.trim()
    if (trimmed) {
      return (
        <AgentsEmpty
          title={t('agents.list.noMatches', 'No agents match “{{query}}”', { query: trimmed })}
        />
      )
    }
    if (hosts.length === 0) {
      return (
        <AgentsEmpty
          title={t('agents.list.emptyTitle', 'No agents running')}
          message={t('agents.list.pairComputer', 'Pair a computer to see its agents here.')}
        />
      )
    }
    // "No agents running" is only true of a computer that answered.
    if (!list.anyLive) {
      return awaitingDesktop ? (
        <View style={styles.connecting}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : (
        <AgentsEmpty
          title={t('agents.list.noComputerTitle', 'No computer connected')}
          message={t('agents.list.noComputerBody', 'Agents show up here once a computer connects.')}
        />
      )
    }
    return (
      <AgentsEmpty
        title={t('agents.list.emptyTitle', 'No agents running')}
        message={t(
          'agents.list.emptyBody',
          'Start an agent in any workspace and it shows up here.'
        )}
      />
    )
  }

  const body = !data.hostCatalogLoaded
    ? null
    : list.sections.length === 0
      ? emptyState()
      : list.sections.map((section, index) => (
          <View key={section.key}>
            <AgentListSectionHeading
              section={section}
              host={hosts.find((host) => host.id === section.hostId) ?? null}
              nameDesktop={nameDesktops}
              first={index === 0}
              now={now}
              onClear={section.kind === 'done' ? clearSection(section) : undefined}
            />
            <MobileAgentListRows
              rows={section.rows}
              idleRows={section.idleRows}
              idleKey={view.groupBy}
              footer={section.footer}
              nameDesktop={section.nameDesktop}
              hosts={hosts}
              now={now}
              handlers={props.handlers}
            />
          </View>
        ))

  return (
    <>
      <MobileHomeTabHeader
        title={t('home.tabs.agents', 'Agents')}
        trailing={
          <MobileHomeTabHeaderButton
            ref={moreRef}
            icon={Ellipsis}
            accessibilityLabel={t('agents.options.more', 'More')}
            active={menuOpen}
            onPress={() => setMenuOpen(true)}
          />
        }
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: barHeight + spacing.sm },
          isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={pullToRefresh}
            tintColor={colors.textSecondary}
            colors={[colors.textSecondary]}
          />
        }
      >
        {body}
      </ScrollView>
      {props.active ? (
        <MobileHomeAgentsBottomBar
          query={query}
          onQueryChange={setQuery}
          onCoveredHeightChange={onBarHeight}
          onNewWorkspace={props.onNewWorkspace}
          hosts={hosts}
          hostFilter={hostFilter}
          view={view}
          onHostFilterChange={setPickedHost}
          onViewChange={setView}
        />
      ) : null}
      <PullDownMenu
        visible={menuOpen}
        anchorRef={moreRef}
        groups={menuGroups}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}

function AgentListSectionHeading(props: {
  section: AgentListSection
  host: HostProfile | null
  nameDesktop: boolean
  first: boolean
  now: number
  /** The Done heading's "Clear": the same as Clear finished. */
  onClear?: () => void
}) {
  const t = useMobileTranslation()
  const { section } = props
  const desktop = useHostDisplay(props.host).title
  if (section.kind === 'idle') {
    return <View style={homeListStyles.headinglessGroup} />
  }
  const titles: Partial<Record<AgentListSection['kind'], string>> = {
    'needs-you': t('agents.sections.needsYou', 'Needs you'),
    working: t('agents.sections.working', 'Working'),
    done: t('agents.sections.done', 'Done'),
    desktop
  }
  const counted = section.kind !== 'workspace' && section.kind !== 'project'
  const seen = section.lastSeen
  const seenAgo =
    seen?.at === undefined
      ? null
      : props.now - seen.at < 60_000
        ? null
        : formatTimeAgo(seen.at, props.now)
  const aside = seen
    ? seen.offline
      ? seen.at === undefined
        ? t('agents.sections.offline', 'Offline')
        : seenAgo
          ? t('agents.sections.offlineSeenAgo', 'Offline · seen {{ago}} ago', { ago: seenAgo })
          : t('agents.sections.offlineSeenJustNow', 'Offline · seen just now')
      : seenAgo
        ? t('agents.sections.seenAgo', 'Seen {{ago}} ago', { ago: seenAgo })
        : t('agents.sections.seenJustNow', 'Seen just now')
    : props.nameDesktop && (section.kind === 'workspace' || section.kind === 'project')
      ? desktop
      : undefined
  return (
    <MobileHomeSectionHeading
      title={titles[section.kind] ?? section.title ?? ''}
      count={counted ? section.rows.length : undefined}
      aside={props.onClear ? t('agents.sections.clear', 'Clear') : aside}
      asideIcon={seen?.offline ? WifiOff : undefined}
      onAsidePress={props.onClear}
      first={props.first}
    />
  )
}

function AgentsEmpty(props: { title: string; message?: string }) {
  return <MobileHomeTabEmpty icon={SquareTerminal} {...props} />
}

const styles = themedStyleSheet(() => ({
  content: { paddingHorizontal: spacing.lg },
  connecting: { alignItems: 'center', paddingVertical: spacing.xl, marginTop: 32 }
}))
