import { Bot, ChevronRight, Monitor, Search, SlidersHorizontal, WifiOff } from 'lucide-react-native'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import {
  AGENT_LIST_GROUP_BY_CHOICES,
  buildAgentList,
  DEFAULT_AGENT_LIST_VIEW,
  summarizeAgentListHosts,
  type AgentListGroupBy,
  type AgentListSection
} from '../../agents/agent-list-model'
import { loadAgentListView, saveAgentListView } from '../../agents/agent-list-preferences'
import { MobileAgentListRows, type AgentListRowHandlers } from '../../agents/MobileAgentListRows'
import type { ActionSheetAction } from '../../components/ActionSheetModal'
import { MobileSearchField } from '../../components/MobileSearchField'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { PickerModal, type PickerOption } from '../../components/PickerModal'
import { hostPickerOptions } from '../../components/use-connected-host-picker'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { useSerializedStoredState } from '../../storage/use-serialized-stored-state'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { HostProfile } from '../../transport/types'
import { useHostDisplay } from '../../transport/use-host-display'
import { formatTimeAgo } from '../../worktree/agent-row-display'
import { homeListStyles } from '../home-list-styles'
import { MobileHomeSectionHeading } from '../MobileHomeSectionHeading'
import type { MobileHomeData } from '../use-mobile-home-data'
import { MobileHomePill } from './MobileHomeHostPill'
import { MobileHomeTabHeader, MobileHomeTabHeaderButton } from './MobileHomeTabHeader'

const ALL_DESKTOPS = '__all__'

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
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menu, setMenu] = useState<'closed' | 'options' | 'group-by'>('closed')
  const optionsRef = useRef<View>(null)
  // An unpaired desktop's filter falls back to every desktop.
  const hostFilter = hosts.some((host) => host.id === pickedHost) ? pickedHost : null
  const { now } = data.agentList
  const list = useMemo(
    () => buildAgentList(data.agentList, { view, hostFilter, query }),
    [data.agentList, view, hostFilter, query]
  )
  const nameDesktops = hosts.length > 1 && hostFilter === null
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
              id: 'show-workers',
              label: t('agents.options.showWorkers', 'Show worker agents'),
              checked: view.showWorkers,
              onPress: () => setView({ ...view, showWorkers: !view.showWorkers })
            }
          ]
        ]

  const body = !data.hostCatalogLoaded ? null : list.sections.length === 0 ? (
    <AgentsEmpty
      title={
        query.trim()
          ? t('agents.list.noMatches', 'No agents match “{{query}}”', { query: query.trim() })
          : t('agents.list.emptyTitle', 'No agents running')
      }
      message={
        query.trim()
          ? undefined
          : hosts.length === 0
            ? t('agents.list.pairDesktop', 'Pair a desktop to see its agents here.')
            : t('agents.list.emptyBody', 'Start an agent in any workspace and it shows up here.')
      }
    />
  ) : (
    list.sections.map((section, index) => (
      <View key={section.key}>
        <AgentListSectionHeading
          section={section}
          host={hosts.find((host) => host.id === section.hostId) ?? null}
          nameDesktop={nameDesktops}
          first={index === 0}
          now={now}
        />
        <MobileAgentListRows
          rows={section.rows}
          idleRows={section.idleRows}
          idleKey={view.groupBy}
          footer={section.footer}
          nameDesktop={section.nameDesktop}
          hosts={hosts}
          now={now}
          onOpen={props.handlers.onOpen}
          onLongPress={props.handlers.onLongPress}
        />
      </View>
    ))
  )

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
          placeholder={t('agents.search.placeholder', 'Search agents')}
          onClear={() => setQuery('')}
          autoFocus
          style={styles.search}
        />
      ) : null}
      {hosts.length > 1 ? (
        <View style={styles.filters}>
          <DesktopFilter hosts={hosts} selected={hostFilter} onOpen={() => setPickerOpen(true)} />
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
      </ScrollView>
      <PullDownMenu
        visible={menu !== 'closed'}
        anchorRef={optionsRef}
        groups={menuGroups}
        onClose={() => setMenu('closed')}
      />
      {hosts.length > 1 ? (
        <PickerModal
          visible={pickerOpen}
          title={t('agents.desktops.pickerTitle', 'Show agents on')}
          options={desktopFilterOptions(hosts, summarizeAgentListHosts(data.agentList), t)}
          selected={hostFilter ?? ALL_DESKTOPS}
          onSelect={(value) => setPickedHost(value === ALL_DESKTOPS ? null : value)}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  )
}

function desktopFilterOptions(
  hosts: readonly HostProfile[],
  summaries: ReturnType<typeof summarizeAgentListHosts>,
  t: Translate
): PickerOption[] {
  const agentCount = (count: number) =>
    count === 1
      ? t('agents.desktops.agents_one', '{{count}} agent', { count })
      : t('agents.desktops.agents_other', '{{count}} agents', { count })
  const total = summaries.reduce((sum, summary) => sum + summary.agents, 0)
  const icon = (offline: boolean) => () =>
    offline ? (
      <WifiOff size={17} color={colors.textMuted} />
    ) : (
      <Monitor size={17} color={colors.textPrimary} />
    )
  return [
    {
      value: ALL_DESKTOPS,
      label: t('agents.desktops.all', 'All desktops'),
      subtitle: agentCount(total),
      renderIcon: icon(false)
    },
    ...hostPickerOptions([...hosts]).map((option) => {
      const summary = summaries.find((entry) => entry.hostId === option.value)
      const needsYou = summary?.needsYou ?? 0
      return {
        value: option.value,
        label: option.label,
        subtitle: summary?.offline
          ? t('agents.desktops.offline', 'Offline')
          : [
              agentCount(summary?.agents ?? 0),
              needsYou > 0
                ? needsYou === 1
                  ? t('agents.desktops.needsYou_one', '{{count}} needs you', { count: needsYou })
                  : t('agents.desktops.needsYou_other', '{{count}} need you', { count: needsYou })
                : null
            ]
              .filter(Boolean)
              .join(' · '),
        renderIcon: icon(summary?.offline ?? false)
      }
    })
  ]
}

function DesktopFilter(props: {
  hosts: readonly HostProfile[]
  selected: string | null
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const selected = props.hosts.find((host) => host.id === props.selected) ?? null
  const title = useHostDisplay(selected).title
  const label = selected ? title : t('agents.desktops.all', 'All desktops')
  return (
    <MobileHomePill
      label={label}
      leading={<Monitor size={14} color={colors.textPrimary} />}
      accessibilityLabel={t('home.tabs.chooseDesktop', '{{desktop}}, choose another desktop', {
        desktop: label
      })}
      onPress={props.onOpen}
    />
  )
}

function AgentListSectionHeading(props: {
  section: AgentListSection
  host: HostProfile | null
  nameDesktop: boolean
  first: boolean
  now: number
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
      aside={aside}
      asideIcon={seen?.offline ? WifiOff : undefined}
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
