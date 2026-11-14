import { memo, useCallback, useEffect, useMemo, type ReactElement } from 'react'
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  View
} from 'react-native'
import { ChevronRight, FolderTree, Pin } from 'lucide-react-native'
import { AuthFailedBanner } from '../../components/AuthFailedBanner'
import { Presence } from '../../components/AutoHeight'
import { DisclosureChevron } from '../../components/DisclosureChevron'
import { HostDiagnosticsLink } from '../../components/HostDiagnosticsLink'
import { HostOfflineBanner, useHostOfflineBanner } from '../../components/HostOfflineBanner'
import { isConnectionOutage } from '../../transport/connection/connection-health'
import { HostRouteNoticeBanner } from '../../components/HostRouteNoticeBanner'
import { MobileRepoIcon } from '../../components/MobileRepoIcon'
import type { CollapsingTitle } from '../../components/nav-bar/PageTitle'
import { WorktreeListRow } from '../../worktree/row-presentation/WorktreeListRow'
import { WORKTREE_ROW_LAYOUT } from '../../worktree/row-presentation/worktree-list-row-layout'
import { colors, spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { getWorktreeRowIdentity } from '../../worktree/row-presentation/worktree-host-row-identity'
import {
  HostWorkspaceListReopen,
  HostWorkspaceListStates
} from '../../worktree/execution-hosts/host-workspace-list-states'
import {
  getWorktreeDotStatus,
  hasWorktreeAgentState
} from '../../worktree/workspace-list/workspace-list-ordering'
import type {
  Section,
  WorkspaceListItem,
  Worktree
} from '../../worktree/workspace-list/workspace-list-types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../../src/shared/repo-badge-color'
import { getWorktreeCardDetails } from '../../../../src/shared/worktree/row-display/card-properties'
import { hostScreenStyles as styles } from '../host-screen-styles'
import { useRepoLookById, type RepoLook } from '../catalog/host-repo-looks'
import { HostPendingCreationRow } from './host-pending-creation-row'
import { useSlowPendingKeys } from './use-slow-pending-keys'
import { useHostMutationDrafts } from '../../query/host-mutation-drafts'
import { workspaceRenameDraftKey } from '../workspace-actions/workspace-rename-sheet'
import { projectGroupHeaderIndent } from '../../worktree/project-sections/project-group-indent'
import type { HostScreenController } from '../use-host-screen-controller'

export function HostWorkspaceList({
  controller,
  bottomBarHeight,
  pageTitle
}: {
  controller: HostScreenController
  /** The bottom bar floats over the list's end; rows pad by it so the last one stays reachable. */
  bottomBarHeight: number
  /** The host name at the top of the list, folding into the bar as it scrolls. */
  pageTitle?: { element: ReactElement; collapsing: CollapsingTitle }
}) {
  const colorScheme = useMobileColorScheme()
  const {
    actions,
    activeWorktreeScroll,
    catalog,
    client,
    connState,
    contentMaxWidth,
    displayWorktrees,
    embedded,
    forceReconnectHost,
    hostDisplay,
    hostId,
    insets,
    isReadOnly,
    isWideLayout,
    lastConnectedAt,
    noticeParam,
    reconnectAttempts,
    relayRecovery,
    routeNotice,
    router,
    sectionsResult,
    setDismissedNotice,
    settings,
    state
  } = controller
  const { rawSections, sections, repoById } = sectionsResult
  const { pending } = settings.pendingViewChanges
  // A collapse the desktop has not answered within SLOW_PENDING_MS spins on its header.
  const pendingCollapseKeys = useSlowPendingKeys(
    useMemo(
      () => new Set(pending.flatMap((change) => (change.kind === 'collapse' ? [change.key] : []))),
      [pending]
    )
  )
  const hasRows = sections.length > 0
  const offlineBanner = useHostOfflineBanner({
    client,
    connState,
    lastConnectedAt,
    outage: isConnectionOutage(controller.connectionVerdict),
    forceReconnect: hostId && forceReconnectHost ? () => void forceReconnectHost(hostId) : null,
    // Group headers can stand with no rows under them; that list says "unreachable" in its body.
    hasData: (controller.feed ? sections.length : displayWorktrees.length) > 0,
    asOf: catalog.readAt
  })
  const renameDrafts = useHostMutationDrafts()
  const resetTitle = pageTitle?.collapsing.reset
  useEffect(() => {
    if (!hasRows) {
      resetTitle?.()
    }
  }, [hasRows, resetTitle])
  const repoLookById = useRepoLookById(repoById)
  const { worktreeCardProperties, compactWorktreeCards, newCardStyle } = state.view
  const cardDetails = useMemo(
    () => getWorktreeCardDetails(worktreeCardProperties, { compactWorktreeCards, newCardStyle }),
    [worktreeCardProperties, compactWorktreeCards, newCardStyle]
  )
  const sectionCounts = useMemo(
    () => new Map(rawSections.map((section) => [section.key, section.data.length])),
    [rawSections]
  )
  const { collapsedGroups } = controller
  const { groupBy, agentActivityDisplayMode } = state.view
  const { toggleCollapsed, toggleWorktreeLineage } = settings
  const { setActionTarget } = state
  const { openWorktreeSession } = actions
  const statusLive = connState === 'connected'

  const renderSectionHeader = useCallback(
    ({ section }: { section: Section }) => {
      const collapseKey = section.collapseKey ?? section.key
      return (
        <HostSectionHeader
          title={section.title}
          icon={section.icon}
          isProjectGroup={section.isProjectGroup}
          projectGroupDepth={section.projectGroupDepth}
          pendingCreations={section.pendingCreations}
          collapseKey={collapseKey}
          collapsed={collapsedGroups.has(collapseKey)}
          count={section.count ?? sectionCounts.get(section.key) ?? 0}
          pending={pendingCollapseKeys.has(collapseKey)}
          groupByRepo={groupBy === 'repo'}
          repoLook={groupBy === 'repo' && section.repo ? repoLookById.get(section.repo.id) : null}
          onToggle={toggleCollapsed}
        />
      )
    },
    [collapsedGroups, sectionCounts, pendingCollapseKeys, groupBy, repoLookById, toggleCollapsed]
  )

  const renderItem = useCallback(
    ({ item: { row: item, view } }: { item: WorkspaceListItem }) => (
      <WorktreeListRow
        item={item}
        view={view}
        isReadOnly={isReadOnly}
        status={hasWorktreeAgentState(item) ? getWorktreeDotStatus(item) : null}
        repoColor={repoLookById.get(item.repoId)?.color ?? DEFAULT_REPO_BADGE_COLOR}
        repoIcon={repoLookById.get(item.repoId)?.icon ?? null}
        hideRepo={groupBy === 'repo' && !view.showProjectName}
        cardDetails={cardDetails}
        agentActivityDisplayMode={agentActivityDisplayMode}
        onPress={openWorktreeSession}
        onAgentPress={openWorktreeSession}
        statusLive={statusLive && !view.hostContextHealthLabel}
        onLongPress={item.workspaceKind === 'folder-workspace' ? undefined : setActionTarget}
        onToggleLineage={toggleWorktreeLineage}
        unsavedName={unsavedRename(renameDrafts, hostId, item)}
      />
    ),
    [
      renameDrafts,
      hostId,
      isReadOnly,
      cardDetails,
      repoLookById,
      groupBy,
      agentActivityDisplayMode,
      openWorktreeSession,
      statusLive,
      setActionTarget,
      toggleWorktreeLineage
    ]
  )

  // Group headers can exist before any row loads; the state then sits under them, not above the title.
  const listState =
    controller.feed?.kind === 'reopen' ? null : (
      <HostWorkspaceListStates
        connState={connState}
        connectionVerdict={controller.connectionVerdict}
        // A feed-built list is loaded once the feed installs; rows draw before worktree.ps answers.
        worktreesLoaded={controller.feed ? controller.feed.kind === 'ready' : state.worktreesLoaded}
        // A feed-built list counts its sections, so collapsed ones and a failing worktree.ps never blank it.
        displayCount={controller.feed ? sections.length : displayWorktrees.length}
        sectionCount={sections.length}
        catalogError={state.catalogError}
        search={state.search}
        activeFilterCount={controller.activeFilterCount}
        bottomInset={hasRows ? 0 : Math.max(bottomBarHeight, insets.bottom)}
        onClearSearch={() => state.setSearch('')}
        onReconnect={hostId && forceReconnectHost ? () => void forceReconnectHost(hostId) : null}
      />
    )

  return (
    <>
      {/* Banners ease in and out; a dismissed one keeps its message while it leaves. */}
      <Presence>
        {(connState === 'auth-failed' || relayRecovery.pairingRejected) && (
          <AuthFailedBanner
            canRetry={!!hostId && forceReconnectHost !== null}
            onRetry={() => hostId && forceReconnectHost && void forceReconnectHost(hostId)}
            onRepair={() => router.push('/pair-scan')}
            onRemove={() => state.setConfirmRemoveHost(true)}
          />
        )}
      </Presence>

      {connState !== 'connected' &&
      !relayRecovery.pairingRejected &&
      reconnectAttempts >= 3 &&
      hostId ? (
        <HostDiagnosticsLink
          onPress={() =>
            router.push({ pathname: '/connection-log', params: { hostId: String(hostId) } })
          }
        />
      ) : null}

      <Presence>
        {routeNotice && (
          <HostRouteNoticeBanner
            message={routeNotice}
            onDismiss={() => setDismissedNotice(noticeParam ?? null)}
          />
        )}
      </Presence>
      <Presence>
        {state.serverNotice ? (
          <HostRouteNoticeBanner
            message={state.serverNotice}
            onDismiss={() => state.setServerNotice(null)}
          />
        ) : null}
      </Presence>

      {/* Keep action errors above the list so the header and reopened confirm remain usable. */}
      <Presence>
        {state.actionError !== '' && (
          <HostRouteNoticeBanner
            message={state.actionError}
            tone="failure"
            onDismiss={() => state.setActionError('')}
          />
        )}
      </Presence>

      {hasRows ? null : pageTitle?.element}

      {controller.feed?.kind === 'reopen' ? (
        <HostWorkspaceListReopen aboveRows={sections.length > 0} />
      ) : hasRows ? null : (
        listState
      )}

      {sections.length > 0 && (
        <Animated.SectionList
          ref={activeWorktreeScroll.sectionListRef}
          ListHeaderComponent={
            <>
              {pageTitle?.element}
              {offlineBanner ? (
                <View style={styles.offlineBanner}>
                  <HostOfflineBanner
                    hostName={hostDisplay.title}
                    offline={offlineBanner.offline}
                    asOf={offlineBanner.asOf}
                    onRetry={offlineBanner.retry}
                  />
                </View>
              ) : null}
            </>
          }
          ListFooterComponent={listState ?? undefined}
          onScroll={pageTitle?.collapsing.onScroll}
          {...pageTitle?.collapsing.touchHandlers}
          scrollEventThrottle={16}
          sections={sections}
          extraData={colorScheme}
          keyExtractor={({ row, view }) => view.sectionListKey ?? getWorktreeRowIdentity(row)}
          stickySectionHeadersEnabled={false}
          // Why: keep the search IME up while tapping clear.
          keyboardShouldPersistTaps="handled"
          // React Native Web dismisses on-drag for any scroll, including one caused by narrowing search.
          keyboardDismissMode={Platform.OS === 'web' ? 'none' : 'on-drag'}
          onScrollToIndexFailed={activeWorktreeScroll.onScrollToIndexFailed}
          contentContainerStyle={[
            styles.list,
            // Before the bar measures, the safe area still keeps the last row off the home indicator.
            { paddingBottom: Math.max(bottomBarHeight, insets.bottom) + spacing.sm },
            isWideLayout &&
              !embedded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
          ]}
          renderSectionHeader={renderSectionHeader}
          ItemSeparatorComponent={ListSeparator}
          // Why (#8498): manual pull-to-refresh forces a fresh snapshot after a stale-cache reconnect.
          refreshControl={
            <RefreshControl
              refreshing={catalog.refreshing}
              onRefresh={catalog.onRefresh}
              tintColor={colors.textSecondary}
              colors={[colors.textSecondary]}
            />
          }
          renderItem={renderItem}
        />
      )}
    </>
  )
}

// The row keeps its real name; a rename the desktop never took is shown under it.
function unsavedRename(
  drafts: ReadonlyMap<string, string>,
  hostId: string | undefined,
  row: Worktree
): string | undefined {
  const draft = hostId ? drafts.get(workspaceRenameDraftKey(hostId, row)) : undefined
  return draft?.trim() && draft !== row.displayName ? draft : undefined
}

// Takes the header's own fields, not the section, so a poll that rebuilds sections skips unchanged headers.
const HostSectionHeader = memo(function HostSectionHeader(props: {
  title: string
  icon: Section['icon']
  isProjectGroup: boolean | undefined
  projectGroupDepth: number | undefined
  pendingCreations: Section['pendingCreations']
  collapseKey: string
  collapsed: boolean
  count: number
  pending: boolean
  groupByRepo: boolean
  repoLook: RepoLook | null | undefined
  onToggle: (collapseKey: string) => void
}) {
  useMobileColorScheme()
  const pendingCreations = props.pendingCreations?.map((creation) => (
    <HostPendingCreationRow key={creation.key} creation={creation} />
  ))
  if (!props.title) {
    return pendingCreations ? <>{pendingCreations}</> : null
  }
  return (
    <>
      <Pressable
        style={({ pressed }) => [
          styles.sectionHeader,
          props.projectGroupDepth
            ? {
                paddingLeft:
                  WORKTREE_ROW_LAYOUT.indicatorInset +
                  projectGroupHeaderIndent(props.projectGroupDepth)
              }
            : null,
          pressed && { backgroundColor: colors.translucentFill }
        ]}
        onPress={() => props.onToggle(props.collapseKey)}
      >
        <View style={styles.sectionChevron}>
          <DisclosureChevron expanded={!props.collapsed} collapsedDeg={0} expandedDeg={90}>
            <ChevronRight size={12} color={colors.textMuted} />
          </DisclosureChevron>
        </View>
        {props.icon === 'pin' && (
          <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
        )}
        {props.groupByRepo && props.isProjectGroup ? (
          <FolderTree size={12} color={colors.textPrimary} style={styles.sectionIcon} />
        ) : props.groupByRepo ? (
          <View style={styles.sectionRepoIcon}>
            <MobileRepoIcon
              repoIcon={props.repoLook?.icon ?? null}
              size={14}
              color={props.repoLook?.color ?? colors.textSecondary}
            />
          </View>
        ) : null}
        <Text style={styles.sectionTitle}>{props.title}</Text>
        <Text style={styles.sectionCount}>{props.count}</Text>
        {props.pending && (
          <ActivityIndicator
            size="small"
            color={colors.textMuted}
            style={styles.sectionPendingSpinner}
          />
        )}
      </Pressable>
      {pendingCreations}
    </>
  )
})

function ListSeparator() {
  useMobileColorScheme()
  return <View style={styles.separator} />
}
