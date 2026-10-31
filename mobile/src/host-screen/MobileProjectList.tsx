import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { AuthFailedBanner } from '../components/AuthFailedBanner'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { filterWorktrees } from '../worktree/workspace-list-sections'
import { rowFiltersForView } from '../worktree/workspace-view-settings'
import {
  buildMobileProject,
  sharedProjectCategories,
  projectMatchesFilter,
  sortMobileProjects,
  type ProjectQuickFilter
} from './mobile-project-navigation'
import { MobileProjectRow } from './MobileProjectRow'
import { projectSnapshotKey, useMobileProjectSessions } from './use-mobile-project-sessions'
import { projectListStyles as styles } from './mobile-project-list-styles'
import type { HostScreenController } from './use-host-screen-controller'

export { MobileProjectRow } from './MobileProjectRow'

export function MobileProjectList({
  controller,
  bottomBarHeight = 0
}: {
  controller: HostScreenController
  bottomBarHeight?: number
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { hostId, displayWorktrees, state, connState, actions, catalog, relayRecovery } = controller
  const snapshots = useMobileProjectSessions(controller)
  const FILTERS: readonly { id: ProjectQuickFilter; label: string }[] = [
    { id: 'all', label: t('hostScreen.projectNavigation.all', 'All') },
    {
      id: 'attention',
      label: t('hostScreen.projectNavigation.statusNeedsAttention', 'Needs attention')
    },
    { id: 'working', label: t('hostScreen.projectNavigation.statusWorking', 'Working') },
    { id: 'unread', label: t('hostScreen.projectNavigation.unread', 'Unread') }
  ]
  const [filter, setFilter] = useState<ProjectQuickFilter>('all')
  const isConnected = connState === 'connected'
  const [wasConnected, setWasConnected] = useState(isConnected)
  const [connectionEpisode, setConnectionEpisode] = useState(0)
  const [dismissedConnectionNotice, setDismissedConnectionNotice] = useState<string | null>(null)
  if (isConnected !== wasConnected) {
    setWasConnected(isConnected)
    if (!isConnected) {
      setConnectionEpisode((n) => n + 1)
    }
  }
  const categoryKey = (category: string) => `mobile-project-category:${category}`
  const toggleCategory = (category: string) => {
    controller.settings.toggleCollapsed(categoryKey(category))
  }
  const projects = useMemo(
    () =>
      sortMobileProjects(
        filterWorktrees(
          displayWorktrees,
          rowFiltersForView(state.view),
          '',
          state.repoHostIdByRepoId
        ).map((w) =>
          buildMobileProject(
            w,
            snapshots.get(projectSnapshotKey(w.hostId, w.worktreeId)),
            connState === 'connected' && !w.hostContextHealthLabel,
            sharedProjectCategories(displayWorktrees)
          )
        )
      ),
    [displayWorktrees, state.view, state.repoHostIdByRepoId, snapshots, connState, t]
  )
  const query = state.search.trim().toLowerCase()
  const visible = projects.filter(
    (p) =>
      projectMatchesFilter(p, filter) &&
      (!query ||
        [p.title, p.worktree.displayName, ...p.sessions.map((s) => s.title)].some((name) =>
          name.toLowerCase().includes(query)
        ))
  )
  const categories = [...new Set(visible.map((p) => p.category))]
  const pinned = projects.filter((project) => project.worktree.isPinned).slice(0, 3)
  return (
    <>
      {(connState === 'auth-failed' || relayRecovery?.pairingRejected) && (
        <AuthFailedBanner
          canRetry={Boolean(hostId && controller.forceReconnectHost)}
          onRetry={() =>
            hostId && controller.forceReconnectHost && void controller.forceReconnectHost(hostId)
          }
          onRepair={() => controller.router.push('/pair-scan')}
          onRemove={() => state.setConfirmRemoveHost(true)}
        />
      )}
      {(() => {
        const noticeKey =
          connState !== 'connected' &&
          connState !== 'auth-failed' &&
          !relayRecovery?.pairingRejected
            ? `${hostId ?? 'local'}:${connectionEpisode}`
            : null
        return noticeKey !== null && dismissedConnectionNotice !== noticeKey ? (
          <HostRouteNoticeBanner
            message={t(
              'hostScreen.projectNavigation.connectionNotice',
              'Checking connection. Workspace status may be out of date.'
            )}
            onDismiss={() => setDismissedConnectionNotice(noticeKey)}
          />
        ) : null
      })()}
      {state.actionError !== '' && (
        <HostRouteNoticeBanner
          message={state.actionError}
          tone="failure"
          onDismiss={() => state.setActionError('')}
        />
      )}
      {controller.routeNotice && (
        <HostRouteNoticeBanner
          message={controller.routeNotice}
          onDismiss={() => controller.setDismissedNotice(controller.noticeParam ?? null)}
        />
      )}
      {state.serverNotice && (
        <HostRouteNoticeBanner
          message={state.serverNotice}
          onDismiss={() => state.setServerNotice(null)}
        />
      )}
      <View style={styles.toolbar}>
        {FILTERS.map((choice) => (
          <Pressable
            key={choice.id}
            style={[styles.chip, filter === choice.id && styles.selected]}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === choice.id }}
            onPress={() => setFilter(choice.id)}
          >
            <Text style={styles.chipText}>{choice.label}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.list,
          { paddingBottom: Math.max(96 + controller.insets.bottom, bottomBarHeight + 24) }
        ]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={catalog.refreshing}
            onRefresh={catalog.onRefresh}
            tintColor={colors.textSecondary}
          />
        }
      >
        {filter === 'all' && !query && pinned.length > 0 && (
          <View style={styles.shortcut}>
            <Text style={styles.category}>
              {t('hostScreen.projectNavigation.pinned', 'Pinned projects')}
            </Text>
            {pinned.map((project) => (
              <MobileProjectRow
                key={project.key}
                project={project}
                onOpen={actions.openWorktreeSession}
              />
            ))}
          </View>
        )}
        {categories.map((category) => {
          const rows = visible.filter((p) => p.category === category)
          const toggled = controller.collapsedGroups.has(categoryKey(category))
          const closed = !query && filter === 'all' && toggled
          const attention = rows.filter((p) =>
            p.sessions.some((s) => !s.archived && s.attention)
          ).length
          return (
            <View key={category}>
              <Pressable
                style={styles.header}
                accessibilityRole="button"
                accessibilityLabel={t(
                  'hostScreen.projectNavigation.category',
                  '{{category}} category',
                  { category }
                )}
                accessibilityState={{
                  expanded: !closed,
                  disabled: Boolean(query || filter !== 'all')
                }}
                disabled={Boolean(query || filter !== 'all')}
                onPress={() => toggleCategory(category)}
              >
                {closed ? (
                  <ChevronRight size={16} color={colors.textSecondary} />
                ) : (
                  <ChevronDown size={16} color={colors.textSecondary} />
                )}
                <Text style={styles.category}>{category}</Text>
                <Text style={[styles.count, attention > 0 && styles.attention]}>
                  {attention
                    ? t(
                        'hostScreen.projectNavigation.attentionCount',
                        'Needs attention: {{total}}',
                        { total: attention }
                      ) + ' · '
                    : ''}
                  {rows.length}
                </Text>
              </Pressable>
              {!closed &&
                rows.map((project) => (
                  <MobileProjectRow
                    key={project.key}
                    project={project}
                    onOpen={actions.openWorktreeSession}
                  />
                ))}
            </View>
          )
        })}
        {visible.length === 0 && (
          <Text style={styles.empty}>
            {state.worktreesLoaded
              ? t('hostScreen.projectNavigation.empty', 'No matching projects.')
              : t('hostScreen.projectNavigation.loading', 'Loading projects.')}
          </Text>
        )}
      </ScrollView>
    </>
  )
}
