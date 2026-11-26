import { CommanderBackNavigation } from './CommanderBackNavigation'
import { useCommanderDetailBack } from './commander-detail-back'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { FlatList, Pressable, Text, View } from 'react-native'
import { agentListPreview } from '../agents/agent-list-row-text'
import { agentStatusGroup, rowNeedsYou } from '../agents/agent-list-rows'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { MobileHomeTabHeader } from '../home/tabs/MobileHomeTabHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { agentStateLabel } from '../worktree/agent-lineage/agent-row-display'
import type { CommanderOverviewProps } from './commander-mobile-data'
import { useCommanderProjects } from './use-commander-projects'
import { projectStages, type ProjectStage } from './commander-projects'
import { CommanderTalkButton } from './CommanderTalkButton'
import { CommanderSegment as Segment } from './CommanderSegment'
import { MobileDecisionInbox } from './MobileDecisionInbox'
import { PhoneMemory } from './PhoneMemory'

export function MobileCommander({
  data,
  handlers,
  active,
  hostScoped,
  onExit
}: CommanderOverviewProps & { onExit: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [panel, setPanel] = useState<'overview' | 'decisions' | 'memory' | 'handoffs'>('overview')
  const [visitedMemory, setVisitedMemory] = useState(false)
  const [visitedHandoffs, setVisitedHandoffs] = useState(false)
  return (
    <CommanderBackNavigation
      active={active}
      hostTitle={hostScoped ? data.sortedHosts[0]?.name : undefined}
      fallback={() => (panel === 'overview' ? onExit() : setPanel('overview'))}
    >
      <View style={styles.fill}>
        <MobileHomeTabHeader title={t('commander.title', 'Commander Center')} />
        {active && <CommanderTalkButton data={data} hostScoped={hostScoped} />}
        <View style={styles.segments}>
          <Segment
            label={t('commander.overview', 'Overview')}
            selected={panel === 'overview'}
            onPress={() => setPanel('overview')}
          />
          <Segment
            label={t('commander.inboxTab', 'Decisions')}
            selected={panel === 'decisions'}
            onPress={() => setPanel('decisions')}
          />
          <Segment
            label={t('commander.handoffs', 'Handoffs')}
            selected={panel === 'handoffs'}
            onPress={() => {
              setVisitedHandoffs(true)
              setPanel('handoffs')
            }}
          />
          <Segment
            label={t('commander.memory', 'Memory')}
            selected={panel === 'memory'}
            onPress={() => {
              setVisitedMemory(true)
              setPanel('memory')
            }}
          />
        </View>
        <View style={panel === 'overview' ? styles.fill : styles.hidden}>
          <CommanderOverview
            data={data}
            handlers={handlers}
            hostScoped={hostScoped}
            active={active && panel === 'overview'}
          />
        </View>
        {panel === 'decisions' && (
          <MobileDecisionInbox data={data} handlers={handlers} active={active} />
        )}
        {visitedHandoffs && (
          <View style={panel === 'handoffs' ? styles.fill : styles.hidden}>
            <PhoneMemory
              handoffs
              data={data}
              hostScoped={hostScoped}
              active={active && panel === 'handoffs'}
            />
          </View>
        )}
        {visitedMemory && (
          <View style={panel === 'memory' ? styles.fill : styles.hidden}>
            <PhoneMemory
              data={data}
              hostScoped={hostScoped}
              active={active && panel === 'memory'}
            />
          </View>
        )}
      </View>
    </CommanderBackNavigation>
  )
}

export function CommanderOverview({ data, handlers, hostScoped, active }: CommanderOverviewProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [attention, setAttention] = useState(false)
  const [agentsNeedingYou, setAgentsNeedingYou] = useState(false)
  const [search, setSearch] = useState('')
  const projects = useCommanderProjects(data, active)
  const hosts = useMemo(
    () => new Map(data.sortedHosts.map((host) => [host.id, host.name])),
    [data.sortedHosts]
  )
  const desktopLabel = (hostId: string, execution: string) =>
    [hostScoped ? '' : hosts.get(hostId), execution === 'local' ? '' : execution]
      .filter(Boolean)
      .join(' · ')
  const project = projects.find((p) => p.key === selectedKey)
  useCommanderDetailBack(active && project ? () => setSelectedKey(null) : null)
  const stages: Record<ProjectStage, string> = {
    'needs-you': t('agents.sections.needsYou', 'Needs you'),
    working: t('agents.sections.working', 'Working'),
    done: t('agents.sections.done', 'Done'),
    idle: agentStateLabel('idle'),
    interrupted: agentStateLabel('interrupted'),
    'last-seen': t('commander.lastSeen', 'Last known')
  }
  const tones: Record<ProjectStage, string> = {
    'needs-you': colors.agentQuestion,
    working: colors.statusGreen,
    done: colors.accentBlue,
    idle: colors.textMuted,
    interrupted: colors.statusAmber,
    'last-seen': colors.inputBorder
  }
  if (project) {
    return (
      <FlatList
        key="agents"
        data={agentsNeedingYou ? project.rows.filter(rowNeedsYou) : project.rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <Pressable
              accessibilityRole="button"
              style={styles.back}
              onPress={() => setSelectedKey(null)}
            >
              <ChevronLeft color={colors.textSecondary} size={18} />
              <Text style={styles.secondary}>{t('commander.projects', 'Projects')}</Text>
            </Pressable>
            <Text style={styles.heading} accessibilityRole="header">
              {project.name}
            </Text>
            {desktopLabel(project.hostId, project.executionHostId) ? (
              <Text style={styles.caption}>
                {desktopLabel(project.hostId, project.executionHostId)}
              </Text>
            ) : null}
            {(project.counts['needs-you'] > 0 || agentsNeedingYou) && (
              <View style={styles.filters}>
                <Segment
                  label={t('home.tabs.agents', 'Agents') + ' (' + project.rows.length + ')'}
                  selected={!agentsNeedingYou}
                  onPress={() => setAgentsNeedingYou(false)}
                />
                <Segment
                  label={t('commander.blockedProjects', 'Needs you ({{total}})', {
                    total: project.counts['needs-you']
                  })}
                  selected={agentsNeedingYou}
                  onPress={() => setAgentsNeedingYou(true)}
                />
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {agentsNeedingYou
              ? t('commander.noPending', 'No agents need your attention.')
              : t('commander.emptyAgents', 'No listed agents in this project.')}
          </Text>
        }
        renderItem={({ item }) => {
          const label = item.stale ? stages['last-seen'] : agentStateLabel(item.dotState)
          const preview = agentListPreview(
            item.entry.agent,
            item.stale ? null : agentStatusGroup(item.dotState),
            item.title
          )
          return (
            <Pressable
              accessibilityRole="button"
              disabled={item.offline || item.stale}
              accessibilityState={{ disabled: item.offline || item.stale }}
              style={styles.row}
              onPress={() => handlers.onOpen(item)}
            >
              <View style={styles.rowBody}>
                <Text style={styles.strong} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.secondary}>
                  {label} · {item.entry.workspaceName}
                </Text>
                {preview ? (
                  <Text numberOfLines={2} style={styles.caption}>
                    {preview}
                  </Text>
                ) : null}
              </View>
              {!item.stale && <ChevronRight color={colors.textMuted} size={18} />}
            </Pressable>
          )
        }}
      />
    )
  }
  const query = search.trim().toLocaleLowerCase()
  const visible = projects.filter(
    (p) =>
      (!attention || p.counts['needs-you'] > 0) &&
      (!query ||
        [p.name, hosts.get(p.hostId)].some((name) => name?.toLocaleLowerCase().includes(query)))
  )
  const unavailable = data.sortedHosts.filter(
    (h) =>
      data.hostStates[h.id] !== 'connected' ||
      !data.agentList.worktreeInfo[h.id]?.agents ||
      data.agentList.worktreeInfo[h.id]?.catalogUnavailable
  )
  return (
    <FlatList
      key="projects"
      keyboardShouldPersistTaps="handled"
      data={visible}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View>
          <MobileSearchField
            accessibilityLabel={t('commander.search', 'Search projects or desktops')}
            placeholder={t('commander.search', 'Search projects or desktops')}
            value={search}
            onChangeText={setSearch}
            onClear={() => setSearch('')}
          />
          <View style={styles.filters}>
            <Segment
              label={t('commander.allProjects', 'All projects ({{total}})', {
                total: projects.length
              })}
              selected={!attention}
              onPress={() => setAttention(false)}
            />
            <Segment
              label={t('commander.blockedProjects', 'Needs you ({{total}})', {
                total: projects.filter((p) => p.counts['needs-you'] > 0).length
              })}
              selected={attention}
              onPress={() => setAttention(true)}
            />
          </View>
          {unavailable.length > 0 && (
            <Text style={styles.caption}>
              {t('commander.unavailable', 'Live status unavailable · {{hosts}}', {
                hosts: unavailable.map((h) => h.name).join(', ')
              })}
            </Text>
          )}
        </View>
      }
      ListEmptyComponent={
        <Text style={styles.empty}>
          {data.sortedHosts.length === 0
            ? t('commander.pair', 'Pair a desktop on the Feed tab to see its projects.')
            : search || attention
              ? t('commander.noMatch', 'No projects match this filter.')
              : t('commander.noProjects', 'No projects reported yet.')}
        </Text>
      }
      renderItem={({ item }) => {
        const counts = projectStages.filter((stage) => item.counts[stage] > 0)
        const description = counts
          .map((stage) => stages[stage] + ' (' + item.counts[stage] + ')')
          .join(' · ')
        return (
          <Pressable
            accessibilityRole="button"
            style={styles.row}
            onPress={() => {
              setAgentsNeedingYou(attention)
              setSelectedKey(item.key)
            }}
          >
            <View style={styles.rowBody}>
              <Text numberOfLines={2} style={styles.strong}>
                {item.name}
              </Text>
              {desktopLabel(item.hostId, item.executionHostId) ? (
                <Text style={styles.caption}>
                  {desktopLabel(item.hostId, item.executionHostId)}
                </Text>
              ) : null}
              {counts.length > 0 && (
                <View style={styles.meter} accessible={false}>
                  {counts.map((stage) => (
                    <View
                      key={stage}
                      style={{ flex: item.counts[stage], backgroundColor: tones[stage] }}
                    />
                  ))}
                </View>
              )}
              <Text style={styles.secondary}>
                {description ||
                  (item.live
                    ? t('commander.emptyAgents', 'No listed agents in this project.')
                    : agentStateLabel('unverifiable'))}
              </Text>
            </View>
            <ChevronRight color={colors.textMuted} size={18} />
          </Pressable>
        )
      }}
    />
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1, minHeight: 0, backgroundColor: colors.bgBase },
  hidden: { display: 'none' },
  segments: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: 2,
    borderRadius: radii.control,
    backgroundColor: colors.bgPanel
  },
  filters: { flexDirection: 'row', marginVertical: spacing.sm, gap: spacing.xs },
  list: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl
  },
  back: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  heading: { fontWeight: '700', fontSize: 21, color: colors.textPrimary },
  strong: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  secondary: { fontSize: 14, color: colors.textSecondary },
  caption: { fontSize: 13, color: colors.textMuted },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderColor: colors.borderSubtle
  },
  rowBody: { flex: 1, gap: spacing.xs },
  meter: {
    height: 4,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: radii.pill,
    marginVertical: 2
  },
  empty: { paddingVertical: spacing.xl, fontSize: 15, color: colors.textSecondary }
}))
