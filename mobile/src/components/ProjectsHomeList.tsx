// The merged Projects home: every paired desktop's workspaces in one list, with
// the same filter / sort / group controls as the per-host list. Replaces Home's
// desktop cards when the Projects home experiment is on.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, Pressable, SectionList, RefreshControl } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { MonitorSmartphone, Search, Settings, X } from 'lucide-react-native'
import { useNow } from '../hooks/use-now'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useOpenMobileSession } from '../session/use-open-mobile-session'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { colors, spacing, typography } from '../theme/mobile-theme'
import {
  executionHostFilterOptions,
  getMergedDesktopRepoId,
  mergeDesktopWorkspaces,
  type MergedWorkspace
} from '../worktree/merged-desktop-workspaces'
import {
  useMergedDesktopCatalogs,
  type DesktopClient
} from '../worktree/use-merged-desktop-catalogs'
import { getMobileWorkspaceLineageGroupKey } from '../worktree/mobile-workspace-lineage'
import { useProjectsHomeViewState } from '../worktree/use-projects-home-view-state'
import { buildSections, getWorktreeStatus } from '../worktree/workspace-list-sections'
import {
  WORKSPACE_GROUP_OPTIONS,
  WORKSPACE_SORT_OPTIONS
} from '../worktree/workspace-list-picker-options'
import { repoColor } from '../worktree/repo-color'
import { MobileSearchField } from './MobileSearchField'
import { OrcaLogo } from './OrcaLogo'
import { PickerModal } from './PickerModal'
import { ProjectsHomeFilterDrawer } from './ProjectsHomeFilterDrawer'
import { WorkspaceListControls } from './WorkspaceListControls'
import { WorkspaceSectionHeader } from './WorkspaceSectionHeader'
import { WorktreeListRow } from './WorktreeListRow'

type Props = {
  desktops: readonly DesktopClient[]
  onOpenSettings: () => void
}

function ListSeparator(): React.JSX.Element {
  return <View style={styles.separator} />
}

export function ProjectsHomeList({ desktops, onOpenSettings }: Props): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const openMobileSession = useOpenMobileSession()
  const now = useNow(30_000)
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [showSortPicker, setShowSortPicker] = useState(false)
  const [showGroupPicker, setShowGroupPicker] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [showDesktopPicker, setShowDesktopPicker] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const view = useProjectsHomeViewState()
  const { catalogs, loading, refresh, rosterSettled } = useMergedDesktopCatalogs(desktops)

  const workspaces = useMemo(() => mergeDesktopWorkspaces(catalogs), [catalogs])
  const hostOptions = useMemo(() => executionHostFilterOptions(workspaces), [workspaces])
  useEffect(() => {
    if (rosterSettled && catalogs.length === desktops.length) {
      view.pruneExecutionHosts(hostOptions)
    }
  }, [catalogs.length, desktops.length, hostOptions, rosterSettled, view.pruneExecutionHosts])
  const repoIconsById = useMemo(
    () =>
      new Map(
        catalogs.flatMap((catalog) =>
          (catalog.repos ?? []).flatMap((repo) =>
            repo.repoIcon
              ? [[getMergedDesktopRepoId(catalog.desktopHostId, repo.id), repo.repoIcon] as const]
              : []
          )
        )
      ),
    [catalogs]
  )
  const repoColorsById = useMemo(
    () =>
      new Map(
        catalogs.flatMap((catalog) =>
          (catalog.repos ?? []).map(
            (repo) =>
              [
                getMergedDesktopRepoId(catalog.desktopHostId, repo.id),
                repo.badgeColor || repoColor(repo.displayName)
              ] as const
          )
        )
      ),
    [catalogs]
  )
  // Ready paired desktops can connect when their host stack opens, even when
  // they sit outside Home's persistent-client budget.
  const unavailableHostIds = useMemo(
    () =>
      new Set(
        desktops
          .filter((desktop) => desktop.state !== 'connected' && !desktop.availableOnDemand)
          .map((desktop) => desktop.hostId)
      ),
    [desktops]
  )

  // Pinning is per-desktop state the merged list does not own yet, so no pins.
  const noPins = useMemo(() => new Set<string>(), [])
  const build = useCallback(
    (collapsedGroups?: ReadonlySet<string>) =>
      buildSections(
        workspaces,
        view.settings.sortMode,
        view.filters,
        search,
        view.settings.groupMode,
        noPins,
        undefined,
        undefined,
        collapsedGroups
      ),
    [workspaces, view.settings.sortMode, view.settings.groupMode, view.filters, search, noPins]
  )
  const sections = useMemo(() => build(view.collapsedGroups), [build, view.collapsedGroups])
  // Group headers show the true group size, so they read the uncollapsed build.
  const rawSections = useMemo(() => build(), [build])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    void refresh().finally(() => setRefreshing(false))
  }, [refresh])

  const openWorkspace = useCallback(
    (item: MergedWorkspace) => {
      openMobileSession({
        hostId: item.desktopHostId,
        worktreeId: item.desktopWorktreeId,
        name: item.displayName || item.repo
      })
    },
    [openMobileSession]
  )

  const toggleLineage = useCallback(
    (item: MergedWorkspace) =>
      view.toggleCollapsedGroup(getMobileWorkspaceLineageGroupKey(item.worktreeId)),
    [view]
  )
  const openHostScreen = useCallback(
    (hostId: string) => router.push(hostStackHostRoute(hostId)),
    [router]
  )
  const desktopOptions = useMemo(
    () =>
      desktops.map((desktop) => ({
        value: desktop.hostId,
        label: desktop.hostName,
        subtitle:
          desktop.state === 'connected'
            ? 'Connected'
            : desktop.availableOnDemand
              ? 'Connect on open'
              : 'Not connected'
      })),
    [desktops]
  )

  const sortLabel =
    WORKSPACE_SORT_OPTIONS.find((option) => option.value === view.settings.sortMode)?.label ??
    'Recent'
  const byRepo = view.settings.groupMode === 'repo'

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topChrome}>
        <View style={styles.titleRow}>
          <View style={styles.logoMark}>
            <OrcaLogo size={18} />
          </View>
          <Text style={styles.title}>Projects</Text>
          {/* New workspace, Tasks and Accounts all live on a single desktop's
              screen, so the merged list must keep a route to one. */}
          <Pressable
            style={styles.iconButton}
            onPress={() => setShowDesktopPicker(true)}
            accessibilityRole="button"
            accessibilityLabel="Open a desktop"
          >
            <MonitorSmartphone size={18} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Settings size={18} color={colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.toolbar}>
          <WorkspaceListControls
            layout="row"
            activeFilterCount={view.activeFilterCount}
            sortLabel={sortLabel}
            groupMode={view.settings.groupMode}
            onOpenFilter={() => setShowFilters(true)}
            onOpenSort={() => setShowSortPicker(true)}
            onOpenGroup={() => setShowGroupPicker(true)}
          />
          <View style={styles.toolbarSpacer} />
          <Pressable
            style={styles.searchToggle}
            onPress={() => setShowSearch((visible) => !visible)}
            accessibilityRole="button"
            accessibilityLabel={showSearch ? 'Close search' : 'Search workspaces'}
          >
            {showSearch ? (
              <X size={16} color={colors.textSecondary} />
            ) : (
              <Search size={16} color={colors.textSecondary} />
            )}
          </Pressable>
        </View>
      </View>

      {showSearch ? (
        <View style={styles.searchBar}>
          <MobileSearchField
            value={search}
            onChangeText={setSearch}
            placeholder="Search workspaces…"
            autoFocus
            focusKey={showSearch}
            accessibilityLabel="Search workspaces"
          />
        </View>
      ) : null}

      {sections.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>
            {loading
              ? 'Loading workspaces…'
              : workspaces.length === 0
                ? 'No workspaces on your paired desktops yet.'
                : 'No workspaces match your filters.'}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.sectionListKey ?? item.worktreeId}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[
            styles.list,
            { paddingBottom: spacing.xl + insets.bottom },
            isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
          ]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textSecondary}
              colors={[colors.textSecondary]}
            />
          }
          ItemSeparatorComponent={ListSeparator}
          renderSectionHeader={({ section }) => {
            if (!section.title) {
              return null
            }
            const repoId = byRepo && section.icon !== 'pin' ? section.data[0]?.repoId : undefined
            return (
              <WorkspaceSectionHeader
                title={section.title}
                count={rawSections.find((raw) => raw.key === section.key)?.data.length ?? 0}
                collapsed={view.collapsedGroups.has(section.key)}
                pinnedGroup={section.icon === 'pin'}
                repoIcon={repoId ? (repoIconsById.get(repoId) ?? null) : undefined}
                repoColor={repoId ? (repoColorsById.get(repoId) ?? null) : null}
                onToggle={() => view.toggleCollapsedGroup(section.key)}
              />
            )
          }}
          renderItem={({ item }) => (
            <WorktreeListRow
              item={item}
              isReadOnly={unavailableHostIds.has(item.desktopHostId)}
              now={now}
              status={getWorktreeStatus(item)}
              repoColor={repoColorsById.get(item.repoId) ?? repoColor(item.repo)}
              repoIcon={repoIconsById.get(item.repoId) ?? null}
              hideRepo={byRepo}
              onPress={openWorkspace}
              onToggleLineage={toggleLineage}
            />
          )}
        />
      )}

      <PickerModal
        visible={showSortPicker}
        title="Sort By"
        options={WORKSPACE_SORT_OPTIONS}
        selected={view.settings.sortMode}
        onSelect={(value) => {
          view.setSortMode(value)
          setShowSortPicker(false)
        }}
        onClose={() => setShowSortPicker(false)}
      />

      <PickerModal
        visible={showGroupPicker}
        title="Group By"
        options={WORKSPACE_GROUP_OPTIONS}
        selected={view.settings.groupMode}
        onSelect={(value) => {
          view.setGroupMode(value)
          setShowGroupPicker(false)
        }}
        onClose={() => setShowGroupPicker(false)}
      />

      <PickerModal
        visible={showDesktopPicker}
        title="Open Desktop"
        options={desktopOptions}
        selected=""
        onSelect={(hostId) => {
          setShowDesktopPicker(false)
          openHostScreen(hostId)
        }}
        onClose={() => setShowDesktopPicker(false)}
      />

      <ProjectsHomeFilterDrawer
        visible={showFilters}
        filters={view.filters}
        executionHostOptions={hostOptions}
        activeFilterCount={view.activeFilterCount}
        onToggleHideSleeping={view.toggleHideSleeping}
        onToggleHideDefaultBranch={view.toggleHideDefaultBranch}
        onToggleExecutionHost={view.toggleExecutionHost}
        onClearFilters={view.clearFilters}
        onClose={() => setShowFilters(false)}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    minHeight: 40
  },
  logoMark: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  iconButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  toolbarSpacer: { flex: 1 },
  searchToggle: { padding: spacing.xs },
  searchBar: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: colors.textSecondary, fontSize: typography.bodySize, textAlign: 'center' },
  list: { paddingBottom: spacing.lg },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 24,
    marginRight: spacing.lg
  }
})
