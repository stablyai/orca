import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react'
import { Animated, Platform, RefreshControl, View } from 'react-native'
import { isBotsListRow, useMobileBotsListParts } from '../../bots/use-mobile-bots-list-parts'
import { AuthFailedBanner } from '../../components/host-connection/AuthFailedBanner'
import { Presence } from '../../components/motion/AutoHeight'
import { HostDiagnosticsLink } from '../../components/host-connection/HostDiagnosticsLink'
import {
  HostOfflineBanner,
  useHostOfflineBanner
} from '../../components/host-connection/HostOfflineBanner'
import { isConnectionOutage } from '../../transport/connection/connection-health'
import { HostRouteNoticeBanner } from '../../components/host-connection/HostRouteNoticeBanner'
import type { CollapsingTitle } from '../../components/nav-bar/PageTitle'
import { WorktreeListRow } from '../../worktree/row-presentation/WorktreeListRow'
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
import {
  getRepoExecutionHostIdOrDefault,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../src/shared/execution-host/execution-host'
import { worktreeListRowStyles as rowStyles } from '../../worktree/row-presentation/worktree-list-row-styles'
import { hostScreenStyles as styles } from '../host-screen-styles'
import { useRepoLookById } from '../catalog/host-repo-looks'
import { HostSectionHeader } from './host-section-header'
import { useSlowPendingKeys } from './use-slow-pending-keys'
import { useHostMutationDrafts } from '../../query/host-mutation-drafts'
import { workspaceRenameDraftKey } from '../workspace-actions/workspace-rename-sheet'
import type { HostScreenController } from '../use-host-screen-controller'
import { isWorktreePinned } from '../../worktree/workspace-list/workspace-list-sections'
import { folderIdOfSelector } from '../../../../src/shared/workspace/identity/workspace-scope'

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
  const bots = useMobileBotsListParts(controller)
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
  const sectionCounts = useMemo(
    () => new Map(rawSections.map((section) => [section.key, section.data.length])),
    [rawSections]
  )
  const { collapsedGroups } = controller
  const { groupBy } = state.view
  const { toggleCollapsed, toggleWorktreeLineage } = settings
  const { setActionTarget } = state
  const { openWorktreeSession, openNewWorktreeModal, setWorktreeUnread, togglePin } = actions
  const { pinnedIds } = state
  // The writes change identity with every catalog read; rows keep one callback so a poll that
  // leaves a row alone doesn't re-render it.
  const rowWrites = useRef({ setWorktreeUnread, togglePin })
  useEffect(() => {
    rowWrites.current = { setWorktreeUnread, togglePin }
  }, [setWorktreeUnread, togglePin])
  const toggleRead = useCallback(
    (row: Worktree) => rowWrites.current.setWorktreeUnread(row, !row.unread),
    []
  )
  const toggleRowPin = useCallback((row: Worktree) => rowWrites.current.togglePin(row), [])
  const canCreate = connState === 'connected' && !isReadOnly
  const firstSectionKey = sections[0]?.key

  const renderSectionHeader = useCallback(
    ({ section }: { section: Section }) => {
      const collapseKey = section.collapseKey ?? section.key
      const first = section.key === firstSectionKey
      const repo = groupBy === 'repo' && !section.isProjectGroup ? section.repo : undefined
      return (
        bots.header(section, collapsedGroups, pendingCollapseKeys, toggleCollapsed, first) ?? (
          <HostSectionHeader
            title={section.title}
            icon={section.icon}
            isProjectGroup={section.isProjectGroup}
            projectGroupDepth={section.projectGroupDepth}
            pendingCreations={section.pendingCreations}
            hasRows={section.data.length > 0}
            collapseKey={collapseKey}
            collapsed={collapsedGroups.has(collapseKey)}
            count={section.count ?? sectionCounts.get(section.key) ?? 0}
            pending={pendingCollapseKeys.has(collapseKey)}
            groupByRepo={groupBy === 'repo'}
            repoLook={groupBy === 'repo' && section.repo ? repoLookById.get(section.repo.id) : null}
            first={first}
            onToggle={toggleCollapsed}
            onNew={
              repo && canCreate
                ? () =>
                    openNewWorktreeModal({
                      id: repo.id,
                      executionHostId: getRepoExecutionHostIdOrDefault(
                        repo,
                        LOCAL_EXECUTION_HOST_ID
                      )
                    })
                : undefined
            }
          />
        )
      )
    },
    [
      collapsedGroups,
      sectionCounts,
      pendingCollapseKeys,
      groupBy,
      repoLookById,
      toggleCollapsed,
      bots,
      firstSectionKey,
      canCreate,
      openNewWorktreeModal
    ]
  )

  const renderSectionFooter = useCallback(
    ({ section }: { section: Section }) => bots.footer(section, collapsedGroups),
    [bots, collapsedGroups]
  )

  const renderItem = useCallback(
    ({
      item: { row: item, view },
      index,
      section
    }: {
      item: WorkspaceListItem
      index: number
      section: Section
    }) => (
      // Each project is one inset group, like Home's: its first and last rows round the corners.
      <View
        style={[
          rowStyles.groupRow,
          index === 0 && !section.pendingCreations?.length && rowStyles.groupFirst,
          index === section.data.length - 1 && rowStyles.groupLast
        ]}
      >
        {bots.groupRow(item, view, isReadOnly) ?? (
          <WorktreeListRow
            item={item}
            view={view}
            isReadOnly={isReadOnly}
            status={hasWorktreeAgentState(item) ? getWorktreeDotStatus(item) : null}
            onPress={openWorktreeSession}
            onAgentPress={openWorktreeSession}
            // A bot's home goes through the bot's own delete, not the workspace menu.
            onLongPress={item.botHome === true || view.botFacts ? undefined : setActionTarget}
            onToggleLineage={toggleWorktreeLineage}
            unsavedName={unsavedRename(renameDrafts, hostId, item)}
            pairedHostId={hostId ?? null}
            // Outside its project's group, or nested under another project, the row names its own.
            repoLook={
              groupBy !== 'repo' || view.showProjectName ? repoLookById.get(item.repoId) : null
            }
            showSelection={embedded}
            // worktree.set resolves git worktrees only, so a folder workspace offers no swipe.
            {...(swipeable(item, view)
              ? {
                  onToggleRead: toggleRead,
                  onTogglePin: toggleRowPin,
                  pinned: isWorktreePinned(item, pinnedIds)
                }
              : {})}
          />
        )}
      </View>
    ),
    [
      bots,
      renameDrafts,
      hostId,
      isReadOnly,
      openWorktreeSession,
      setActionTarget,
      toggleWorktreeLineage,
      toggleRead,
      toggleRowPin,
      pinnedIds,
      repoLookById,
      groupBy,
      embedded
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
        pausedBotMatches={sectionsResult.pausedBotMatches}
        onShowPausedBots={sectionsResult.showPausedBots}
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
                <HostOfflineBanner
                  hostName={hostDisplay.title}
                  offline={offlineBanner.offline}
                  asOf={offlineBanner.asOf}
                  onRetry={offlineBanner.retry}
                />
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
          renderSectionFooter={renderSectionFooter}
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
      {bots.sheets}
    </>
  )
}

function swipeable(row: Worktree, view: WorkspaceListItem['view']): boolean {
  return (
    folderIdOfSelector(row.worktreeId) === undefined &&
    row.botHome !== true &&
    !view.botWorkspace &&
    !view.botFacts
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

function ListSeparator({ leadingItem }: { leadingItem?: WorkspaceListItem }) {
  useMobileColorScheme()
  // A separator keeps the neighbours it mounted with, so the Bots list draws its own dividers.
  return isBotsListRow(leadingItem?.view) ? null : (
    <View style={rowStyles.groupSeparator}>
      <View style={rowStyles.groupSeparatorLine} />
    </View>
  )
}
