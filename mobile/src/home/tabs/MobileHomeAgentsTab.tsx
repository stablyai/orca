import {
  Bot,
  CheckCheck,
  ChevronRight,
  Search,
  SlidersHorizontal,
  Trash2,
  WifiOff
} from 'lucide-react-native'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, ScrollView, Text, View, type HostInstance } from 'react-native'
import {
  AGENT_LIST_GROUP_BY_CHOICES,
  agentListRowsIn,
  buildAgentList,
  DEFAULT_AGENT_LIST_VIEW,
  type AgentListGroupBy,
  type AgentListSection
} from '../../agents/agent-list-model'
import { summarizeAgentListHosts } from '../../agents/agent-list-rows'
import { loadAgentListView, saveAgentListView } from '../../agents/agent-list-preferences'
import { MobileAgentListRows, type AgentListRowHandlers } from '../../agents/MobileAgentListRows'
import { MobileAgentListWorkspaceRows } from '../../agents/MobileAgentListWorkspaceRows'
import {
  matchAgentlessWorkspaces,
  type AgentListWorkspaceMatch
} from '../../agents/agent-list-workspace-matches'
import { useOpenMobileSession } from '../../session/use-open-mobile-session'
import type { ActionSheetAction } from '../../components/ActionSheetModal'
import { MobileSearchField } from '../../components/MobileSearchField'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { useSerializedStoredState } from '../../storage/use-serialized-stored-state'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { HostProfile } from '../../host-catalog/host-profile'
import { useHostDisplay } from '../../host-descriptors/use-host-display'
import { formatTimeAgo } from '../../worktree/agent-row-display'
import { homeListStyles } from '../home-list-styles'
import { MobileHomeSectionHeading } from '../MobileHomeSectionHeading'
import type { MobileHomeData } from '../use-mobile-home-data'
import { AgentsDesktopFilter } from './MobileHomeAgentsDesktopFilter'
import { MobileHomeTabHeader, MobileHomeTabHeaderButton } from './MobileHomeTabHeader'

/** Every agent on every paired desktop, grouped the way the user picked. */
export function MobileHomeAgentsTab(props: {
  data: MobileHomeData
  bottomInset: number
  handlers: AgentListRowHandlers
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
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pickedHost, setPickedHost] = useState<string | null>(null)
  const [menu, setMenu] = useState<'closed' | 'options' | 'group-by'>('closed')
  const optionsRef = useRef<HostInstance>(null)
  // An unpaired desktop's filter falls back to every desktop.
  const hostFilter = hosts.some((host) => host.id === pickedHost) ? pickedHost : null
  const { now } = data.agentList
  const list = useMemo(
    () => buildAgentList(data.agentList, { view, hostFilter, query }),
    [data.agentList, view, hostFilter, query]
  )
  const workspaceMatches = useMemo(
    () => matchAgentlessWorkspaces(data.agentList, { hostFilter, query }),
    [data.agentList, hostFilter, query]
  )
  const openMobileSession = useOpenMobileSession()
  const openWorkspace = (match: AgentListWorkspaceMatch) =>
    openMobileSession({
      hostId: match.hostId,
      worktreeId: match.workspace.worktreeId,
      name: match.workspace.workspaceName
    })
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
  const hostSummaries = useMemo(() => summarizeAgentListHosts(data.agentList), [data.agentList])
  const setView = (next: typeof view) => {
    stored.setValue(next)
    stored.persist(next)
  }

  const groupByLabels: Record<AgentListGroupBy, string> = {
    status: t('agents.groupBy.status', 'Status'),
    workspace: t('agents.groupBy.workspace', 'Workspace'),
    project: t('agents.groupBy.project', 'Project'),
    agent: t('agents.groupBy.agent', 'Agent'),
    desktop: t('agents.groupBy.desktop', 'Desktop')
  }
  const menuGroups: ActionSheetAction[][] =
    menu === 'group-by'
      ? [
          AGENT_LIST_GROUP_BY_CHOICES.map((groupBy) => ({
            id: groupBy,
            label: groupByLabels[groupBy],
            checked: view.groupBy === groupBy,
            onPress: () => setView({ ...view, groupBy })
          }))
        ]
      : [
          [
            {
              id: 'group-by',
              label: t('agents.options.groupBy', 'Group by'),
              skipAutoClose: true,
              renderIcon: () => (
                <View style={styles.menuValue}>
                  <Text style={styles.menuValueText}>{groupByLabels[view.groupBy]}</Text>
                  <ChevronRight size={16} color={colors.textMuted} />
                </View>
              ),
              onPress: () => setMenu('group-by')
            },
            {
              id: 'unread-only',
              label: t('agents.options.unreadOnly', 'Unread only'),
              checked: view.unreadOnly,
              onPress: () => setView({ ...view, unreadOnly: !view.unreadOnly })
            },
            {
              id: 'show-workers',
              label: t('agents.options.showWorkers', 'Show worker agents'),
              checked: view.showWorkers,
              onPress: () => setView({ ...view, showWorkers: !view.showWorkers })
            }
          ],
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
  // A desktop still connecting, or connected with its first list read pending, may yet have agents.
  const awaitingDesktop = filteredHosts.some((host) => {
    const state = data.hostStates[host.id]
    return state === 'connected'
      ? !data.worktreeInfo[host.id]?.catalogUnavailable
      : state === undefined || state === 'connecting' || state === 'handshaking'
  })
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
          message={t('agents.list.pairDesktop', 'Pair a desktop to see its agents here.')}
        />
      )
    }
    // "No agents running" is only true of a desktop that answered.
    if (!list.anyLive) {
      return awaitingDesktop ? (
        <View style={styles.connecting}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : (
        <AgentsEmpty
          title={t('agents.list.noDesktopTitle', 'No desktop connected')}
          message={t('agents.list.noDesktopBody', 'Agents show up here once a desktop connects.')}
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

  const workspacesSection =
    workspaceMatches.length > 0 ? (
      <View key="workspaces-without-agents">
        <MobileHomeSectionHeading
          title={t('agents.sections.workspaces', 'Workspaces')}
          count={workspaceMatches.length}
          first={list.sections.length === 0}
        />
        <MobileAgentListWorkspaceRows
          matches={workspaceMatches}
          hosts={hosts}
          nameDesktop={nameDesktops}
          onOpen={openWorkspace}
        />
      </View>
    ) : null

  const body = !data.hostCatalogLoaded
    ? null
    : list.sections.length === 0
      ? (workspacesSection ?? emptyState())
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
          <>
            <MobileHomeTabHeaderButton
              icon={Search}
              accessibilityLabel={t('agents.search.toggle', 'Search agents')}
              active={searchOpen}
              onPress={() => {
                setSearchOpen((open) => !open)
                setQuery('')
              }}
            />
            <MobileHomeTabHeaderButton
              ref={optionsRef}
              icon={SlidersHorizontal}
              accessibilityLabel={t('agents.options.open', 'Agent list options')}
              active={menu !== 'closed'}
              onPress={() => setMenu('options')}
            />
          </>
        }
      />
      {searchOpen ? (
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('agents.search.placeholder', 'Search agents and workspaces')}
          onClear={() => setQuery('')}
          autoFocus
          style={styles.search}
        />
      ) : null}
      {hosts.length > 1 ? (
        <View style={styles.filters}>
          <AgentsDesktopFilter
            hosts={hosts}
            selected={hostFilter}
            summaries={hostSummaries}
            onSelect={setPickedHost}
          />
        </View>
      ) : null}
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: props.bottomInset },
          isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {body}
        {data.hostCatalogLoaded && list.sections.length > 0 ? workspacesSection : null}
      </ScrollView>
      <PullDownMenu
        visible={menu !== 'closed'}
        anchorRef={optionsRef}
        groups={menuGroups}
        onClose={() => setMenu('closed')}
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
  useMobileColorScheme()
  return (
    <View style={styles.empty}>
      <Bot size={30} strokeWidth={1.6} color={colors.textMuted} />
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {props.title}
      </Text>
      {props.message ? <Text style={styles.emptyBody}>{props.message}</Text> : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  content: { paddingHorizontal: spacing.lg },
  search: { marginHorizontal: spacing.lg, marginBottom: spacing.sm },
  filters: { paddingHorizontal: spacing.lg },
  menuValue: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  connecting: { alignItems: 'center', paddingVertical: spacing.xl, marginTop: 32 },
  menuValueText: { fontSize: 15, color: colors.textMuted },
  empty: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: 28,
    marginTop: 32,
    gap: spacing.sm
  },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  emptyBody: { fontSize: 14, lineHeight: 20, color: colors.textSecondary, textAlign: 'center' }
}))
