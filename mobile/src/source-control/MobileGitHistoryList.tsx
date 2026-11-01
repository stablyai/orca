import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import { ChevronLeft, GitCommitHorizontal } from 'lucide-react-native'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../components/MobileStateView'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { colors, spacing, typography, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useForceReconnect } from '../transport/host-client-hooks'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { resolveMobileBranchBaseRefs } from './mobile-branch-base-ref'
import {
  appendMobileGitHistoryPage,
  buildMobileCommitsListItems,
  buildMobileCommitsView,
  fetchMobileGitHistory,
  type MobileCommitsListItem,
  type MobileGitHistoryPages
} from './mobile-git-history'
import { resolveMobileHistoryScreenView } from './mobile-history-screen-state'
import type { MobileGitHistoryItem } from './git-history-reply-schema'
import { BranchBaseRow, CommitsSectionHeader, renderCommitRow } from './MobileCommitListRows'

export type MobileGitHistoryListProps = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  // Retry must revive a parked reconnect loop.
  hostId: string
  bottomInset: number
  refreshNonce?: number
  // Changes when the branch head or its upstream counts move, from either tab or the desktop.
  refreshKey?: string
  branchName?: string
  busyAction?: string | null
  actionError?: string | null
  // The branch's remote step (Push, Force Push, Publish Branch or Sync) from the shared decision.
  pushLabel?: string
  pushDisabled?: boolean
  pushBusy?: boolean
  // Both reload the list once they settle.
  onPush?: () => Promise<unknown>
  onUpdateBranch?: (baseRef: string) => Promise<unknown>
  // Set when shown as a pushed page, which draws its own back bar.
  onBack?: () => void
  onOpenCommit?: (commit: MobileGitHistoryItem) => void
}

type Loaded = { pages: MobileGitHistoryPages; baseRef: string | null; nowMs: number }

// Memoize the hidden, mounted history list so commit-message keystrokes do not reconcile its FlatList.
export const MobileGitHistoryList = memo(function MobileGitHistoryList({
  client,
  connState,
  worktreeId,
  hostId,
  bottomInset,
  refreshNonce = 0,
  refreshKey = '',
  branchName,
  busyAction = null,
  actionError = null,
  pushLabel,
  pushDisabled = false,
  pushBusy = false,
  onPush,
  onUpdateBranch,
  onBack,
  onOpenCommit
}: MobileGitHistoryListProps) {
  const colorScheme = useMobileColorScheme()
  const t = useMobileTranslation()
  const forceReconnect = useForceReconnect()
  // Keep fetched pages, not formatted rows, so relative times follow a language switch.
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // A pushed page covers the hub's Refresh, and desktop-side commits move no status key, so the list pulls itself.
  const [pulling, setPulling] = useState(false)
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error'>('idle')
  // Action failures render in Changes too; show them here only for actions started here.
  const [ranHere, setRanHere] = useState(false)
  const generation = useRef(0)
  // Paging waits for a first-page reload: its skip would count pages that reload is replacing.
  const reloadingFirstPage = useRef(false)

  const items = useMemo(
    () =>
      loaded
        ? buildMobileCommitsListItems(buildMobileCommitsView(loaded.pages, loaded.nowMs))
        : null,
    [loaded, t]
  )

  useEffect(() => {
    if (!client || connState !== 'connected' || !worktreeId) {
      // Keep loaded rows visible through disconnection.
      return
    }
    const current = ++generation.current
    reloadingFirstPage.current = true
    void (async () => {
      try {
        // The base PRs and rebases target; without one the host lists HEAD's whole history.
        // A failed lookup is a load failure; only a repo with no base gets HEAD's whole history.
        const baseRef = await (
          await resolveMobileBranchBaseRefs(client, worktreeId)
        ).readEffectiveBaseRef()
        const result = await fetchMobileGitHistory(client, worktreeId, { baseRef, skip: 0 })
        if (generation.current === current) {
          reloadingFirstPage.current = false
          setPulling(false)
          // Rows stay up through a refetch; only fresh history clears an earlier failure.
          setError(null)
          setMoreState('idle')
          setLoaded({ pages: appendMobileGitHistoryPage(null, result), baseRef, nowMs: Date.now() })
        }
      } catch (err) {
        if (generation.current === current) {
          reloadingFirstPage.current = false
          setPulling(false)
          setError(
            err instanceof Error
              ? err.message
              : translate('sourceControl.gitHistoryList.loadFailed', 'Failed to load history')
          )
        }
      }
    })()
    // A disconnect or reload retires this load and any page in flight, so a late failure cannot hide kept rows.
    return () => {
      generation.current += 1
      reloadingFirstPage.current = false
      setMoreState((prev) => (prev === 'loading' ? 'idle' : prev))
    }
  }, [client, connState, reloadNonce, refreshKey, refreshNonce, worktreeId])

  // Scrolling pages on its own; after a failed page only the footer's Retry asks again.
  const loadMore = useCallback(
    (retry = false) => {
      if (
        !client ||
        connState !== 'connected' ||
        !loaded?.pages.hasMore ||
        moreState === 'loading' ||
        (moreState === 'error' && !retry) ||
        reloadingFirstPage.current
      ) {
        return
      }
      const current = generation.current
      setMoreState('loading')
      fetchMobileGitHistory(client, worktreeId, {
        baseRef: loaded.baseRef,
        skip: loaded.pages.nextSkip
      }).then(
        (result) => {
          if (generation.current !== current) {
            return
          }
          setMoreState('idle')
          setLoaded((prev) =>
            prev ? { ...prev, pages: appendMobileGitHistoryPage(prev.pages, result) } : prev
          )
        },
        () => {
          if (generation.current === current) {
            setMoreState('error')
          }
        }
      )
    },
    [client, connState, loaded, moreState, worktreeId]
  )

  // Fetching cannot revive a parked reconnect loop; force reconnect and let connState reload.
  const retryAction = connectionRetryAction({
    hostId,
    needsReconnect: connState !== 'connected',
    forceReconnect,
    reload: () => setReloadNonce((n) => n + 1)
  })
  const retry =
    retryAction === null
      ? null
      : () => {
          setError(null)
          retryAction()
        }

  const runHere = useCallback((action: () => Promise<unknown>) => {
    setRanHere(true)
    void action().finally(() => setReloadNonce((n) => n + 1))
  }, [])

  const openCommit = useCallback(
    (id: string) => {
      const item = loaded?.pages.items.find((candidate) => candidate.id === id)
      if (item) {
        onOpenCommit?.(item)
      }
    },
    [loaded, onOpenCommit]
  )

  const connected = client !== null && connState === 'connected'
  const busy = busyAction !== null
  const baseRef = loaded?.baseRef ?? null

  const renderItem = useCallback(
    ({ item }: { item: MobileCommitsListItem }) => {
      if (item.kind === 'section') {
        return (
          <CommitsSectionHeader
            title={item.title}
            push={
              item.push && onPush && pushLabel
                ? {
                    label: pushLabel,
                    busy: pushBusy,
                    disabled: pushDisabled || !connected,
                    onPress: () => runHere(onPush)
                  }
                : null
            }
          />
        )
      }
      if (item.kind === 'base') {
        return (
          <BranchBaseRow
            item={item}
            update={
              item.behind > 0 && item.canUpdateFromBase && onUpdateBranch && baseRef
                ? {
                    busy: busyAction === 'rebase',
                    disabled: busy || !connected,
                    onPress: () => runHere(() => onUpdateBranch(baseRef))
                  }
                : null
            }
          />
        )
      }
      return renderCommitRow(item, openCommit)
    },
    // colorScheme: rows read themed styles at render.
    [
      baseRef,
      busy,
      busyAction,
      colorScheme,
      connected,
      onPush,
      onUpdateBranch,
      openCommit,
      pushBusy,
      pushDisabled,
      pushLabel,
      runHere
    ]
  )

  const header = onBack ? (
    <NavBar
      leading={
        <NavBarButton
          icon={ChevronLeft}
          onPress={onBack}
          accessibilityLabel={t('sourceControl.commits.back', 'Back to source control')}
        />
      }
      title={t('sourceControl.commits.title', 'Commits')}
      subtitle={branchName}
    />
  ) : null

  const view = resolveMobileHistoryScreenView({ connected, rows: items, error })
  let body
  if (view.kind === 'waiting') {
    body = <MobileOfflineState onReconnect={retry} bottomInset={bottomInset} />
  } else if (view.kind === 'error') {
    body = <MobileLoadErrorState error={view.message} onRetry={retry} bottomInset={bottomInset} />
  } else if (view.kind === 'loading') {
    body = (
      <MobileStateView
        loading
        title={t('sourceControl.gitHistoryList.loading', 'Loading commits…')}
        bottomInset={bottomInset}
      />
    )
  } else if (view.kind === 'empty') {
    body = (
      <MobileStateView
        icon={GitCommitHorizontal}
        title={t('sourceControl.gitHistoryList.noCommits', 'No commits.')}
        bottomInset={bottomInset}
      />
    )
  } else {
    body = (
      <FlatList
        data={view.rows}
        extraData={colorScheme}
        renderItem={renderItem}
        keyExtractor={(row) => row.key}
        onEndReached={() => loadMore()}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            // A pull that a disconnect retired settles with the reconnect load; offline it shows nothing.
            refreshing={pulling && connected}
            onRefresh={() => {
              if (connected) {
                setPulling(true)
                setReloadNonce((n) => n + 1)
              }
            }}
            tintColor={colors.textSecondary}
            colors={[colors.textSecondary]}
          />
        }
        ListHeaderComponent={
          ranHere && actionError ? <Text style={styles.actionError}>{actionError}</Text> : null
        }
        ListFooterComponent={
          moreState === 'loading' ? (
            <ActivityIndicator style={styles.footer} size="small" color={colors.textSecondary} />
          ) : moreState === 'error' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => loadMore(true)}
              style={({ pressed }) => [styles.footer, pressed && pressedStyle]}
            >
              <Text style={styles.footerText}>
                {t('sourceControl.commits.loadMoreFailed', 'Couldn’t load more commits. Retry')}
              </Text>
            </Pressable>
          ) : null
        }
        contentContainerStyle={{ paddingBottom: spacing.lg + bottomInset }}
      />
    )
  }

  return (
    <View style={styles.screen}>
      {header}
      {body}
    </View>
  )
})

const styles = themedStyleSheet(() => ({
  screen: { flex: 1 },
  actionError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  footer: { paddingVertical: spacing.lg, alignItems: 'center' },
  footerText: { color: colors.textSecondary, fontSize: typography.metaSize }
}))
