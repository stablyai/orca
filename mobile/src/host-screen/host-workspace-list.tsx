import { useEffect, useMemo, type ReactElement } from 'react'
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  View
} from 'react-native'
import { ChevronDown, ChevronRight, FolderTree, Pin } from 'lucide-react-native'
import { AuthFailedBanner } from '../components/AuthFailedBanner'
import { HostDiagnosticsLink } from '../components/HostDiagnosticsLink'
import { HostRouteNoticeBanner } from '../components/HostRouteNoticeBanner'
import { MobileRepoIcon } from '../components/MobileRepoIcon'
import type { CollapsingTitle } from '../components/nav-bar/PageTitle'
import { WorktreeListRow } from '../components/WorktreeListRow'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import {
  HostWorkspaceListReopen,
  HostWorkspaceListStates
} from '../worktree/host-workspace-list-states'
import { getWorktreeDotStatus } from '../worktree/workspace-list-ordering'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../src/shared/repo-badge-color'
import { getWorktreeCardDetails } from '../../../src/shared/worktree/card-properties'
import { hostScreenStyles as styles } from './host-screen-styles'
import { buildRepoLookById } from './host-repo-looks'
import { HostPendingCreationRow } from './host-pending-creation-row'
import { useSlowPendingKeys } from './use-slow-pending-keys'
import { projectGroupHeaderIndent } from '../worktree/project-group-indent'
import type { HostScreenController } from './use-host-screen-controller'

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
    connState,
    contentMaxWidth,
    displayWorktrees,
    embedded,
    forceReconnectHost,
    hostId,
    insets,
    isReadOnly,
    isWideLayout,
    noticeParam,
    now,
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
  const resetTitle = pageTitle?.collapsing.reset
  useEffect(() => {
    if (!hasRows) {
      resetTitle?.()
    }
  }, [hasRows, resetTitle])
  const repoLookById = useMemo(() => buildRepoLookById(repoById), [repoById])
  const { worktreeCardProperties, compactWorktreeCards, newCardStyle } = state.view
  const cardDetails = useMemo(
    () => getWorktreeCardDetails(worktreeCardProperties, { compactWorktreeCards, newCardStyle }),
    [worktreeCardProperties, compactWorktreeCards, newCardStyle]
  )

  return (
    <>
      {(connState === 'auth-failed' || relayRecovery.pairingRejected) && (
        <AuthFailedBanner
          canRetry={!!hostId && forceReconnectHost !== null}
          onRetry={() => hostId && forceReconnectHost && void forceReconnectHost(hostId)}
          onRepair={() => router.push('/pair-scan')}
          onRemove={() => state.setConfirmRemoveHost(true)}
        />
      )}

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

      {routeNotice && (
        <HostRouteNoticeBanner
          message={routeNotice}
          onDismiss={() => setDismissedNotice(noticeParam ?? null)}
        />
      )}
      {state.serverNotice ? (
        <HostRouteNoticeBanner
          message={state.serverNotice}
          onDismiss={() => state.setServerNotice(null)}
        />
      ) : null}

      {/* Keep action errors above the list so the header and reopened confirm remain usable. */}
      {state.actionError !== '' && (
        <HostRouteNoticeBanner
          message={state.actionError}
          tone="failure"
          onDismiss={() => state.setActionError('')}
        />
      )}

      {hasRows ? null : pageTitle?.element}

      {controller.feed?.kind === 'reopen' ? (
        <HostWorkspaceListReopen aboveRows={sections.length > 0} />
      ) : (
        <HostWorkspaceListStates
          connState={connState}
          connectionVerdict={controller.connectionVerdict}
          // A feed-built list is loaded once the feed installs; rows draw before worktree.ps answers.
          worktreesLoaded={
            controller.feed ? controller.feed.kind === 'ready' : state.worktreesLoaded
          }
          // A feed-built list counts its sections, so collapsed ones and a failing worktree.ps never blank it.
          displayCount={controller.feed ? sections.length : displayWorktrees.length}
          sectionCount={sections.length}
          catalogError={state.catalogError}
          search={state.search}
          activeFilterCount={controller.activeFilterCount}
          onAddProject={
            actions.addProjectSupported && connState === 'connected' && !isReadOnly
              ? actions.openCreateMenu
              : undefined
          }
        />
      )}

      {sections.length > 0 && (
        <Animated.SectionList
          ref={activeWorktreeScroll.sectionListRef}
          ListHeaderComponent={pageTitle?.element}
          onScroll={pageTitle?.collapsing.onScroll}
          {...pageTitle?.collapsing.touchHandlers}
          scrollEventThrottle={16}
          sections={sections}
          extraData={colorScheme}
          keyExtractor={(w) => w.sectionListKey ?? getWorktreeRowIdentity(w)}
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
          renderSectionHeader={({ section }) => {
            const pendingCreations = section.pendingCreations?.map((creation) => (
              <HostPendingCreationRow key={creation.key} creation={creation} />
            ))
            if (!section.title) {
              return pendingCreations ? <>{pendingCreations}</> : null
            }
            const collapseKey = section.collapseKey ?? section.key
            const isCollapsed = controller.collapsedGroups.has(collapseKey)
            const count =
              section.count ?? rawSections.find((s) => s.key === section.key)?.data.length ?? 0
            const repoSectionLook =
              state.view.groupBy === 'repo' && section.repo
                ? repoLookById.get(section.repo.id)
                : null
            const repoSectionColor = repoSectionLook?.color ?? null
            const repoSectionIcon = repoSectionLook?.icon ?? null
            return (
              <>
                <Pressable
                  style={[
                    styles.sectionHeader,
                    section.projectGroupDepth
                      ? {
                          paddingLeft:
                            spacing.lg + projectGroupHeaderIndent(section.projectGroupDepth)
                        }
                      : null
                  ]}
                  onPress={() => settings.toggleCollapsed(collapseKey)}
                >
                  {isCollapsed ? (
                    <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
                  ) : (
                    <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
                  )}
                  {section.icon === 'pin' && (
                    <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
                  )}
                  {state.view.groupBy === 'repo' && section.isProjectGroup ? (
                    <FolderTree size={12} color={colors.textPrimary} style={styles.sectionIcon} />
                  ) : state.view.groupBy === 'repo' ? (
                    <View style={styles.sectionRepoIcon}>
                      <MobileRepoIcon
                        repoIcon={repoSectionIcon}
                        size={14}
                        color={repoSectionColor ?? colors.textSecondary}
                      />
                    </View>
                  ) : null}
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  <Text style={styles.sectionCount}>{count}</Text>
                  {pendingCollapseKeys.has(collapseKey) && (
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
          }}
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
          renderItem={({ item }) => (
            <WorktreeListRow
              item={item}
              isReadOnly={isReadOnly}
              now={now}
              status={getWorktreeDotStatus(item)}
              repoColor={repoLookById.get(item.repoId)?.color ?? DEFAULT_REPO_BADGE_COLOR}
              repoIcon={repoLookById.get(item.repoId)?.icon ?? null}
              hideRepo={state.view.groupBy === 'repo' && !item.showProjectName}
              cardDetails={cardDetails}
              agentActivityDisplayMode={state.view.agentActivityDisplayMode}
              onPress={actions.openWorktreeSession}
              onAgentPress={actions.openWorktreeSession}
              statusLive={connState === 'connected' && !item.hostContextHealthLabel}
              onLongPress={
                item.workspaceKind === 'folder-workspace' ? undefined : state.setActionTarget
              }
              onToggleLineage={settings.toggleWorktreeLineage}
            />
          )}
        />
      )}
    </>
  )
}

function ListSeparator() {
  useMobileColorScheme()
  return <View style={styles.separator} />
}
