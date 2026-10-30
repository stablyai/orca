import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useForceReconnect } from '../transport/host-client-hooks'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { GIT_HISTORY_DEFAULT_LIMIT } from '../../../src/shared/git-history-types'
import { fetchMobileGitHistory } from './mobile-git-history'
import type { MobileGitHistoryResult } from './git-history-reply-schema'
import { buildMobileCommitTimeline, type MobileTimelineRow } from './mobile-commit-timeline'
import type { GitHistoryUpstreamVerdict } from '../../../src/shared/git-history-push-state'
import { styles as listStyles } from './mobile-source-control-styles'
import { startOfLocalDay } from './mobile-commit-timeline-time'
import {
  MobileCommitTimelineRow,
  type MobileTimelineBase,
  type MobileTimelineUncommitted
} from './MobileCommitTimelineRows'
import { resolveMobileHistoryScreenView } from './mobile-history-screen-state'
import type { MobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'

type Props = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  // Retry must revive a parked reconnect loop.
  hostId: string
  bottomInset: number
  refreshNonce?: number
  settled: boolean
  // Desktop's compare base once the branch compare knows it; the history reloads to name it.
  baseRef: string | null
  // Where the branch left the base, from the branch compare.
  baseMergeBase: string | null
  base: MobileTimelineBase | null
  // Changes to HEAD or its upstream reload the history.
  headKey: string
  upstream: GitHistoryUpstreamVerdict | null
  uncommitted: MobileTimelineUncommitted | null
  pushAction: MobileSourceControlPrimaryAction | null
  // Push and Rebase run from here, so their failures show here too.
  actionError: string | null
  onOpenChanges: () => void
}

// Memoize the hidden, mounted timeline so commit-message keystrokes do not reconcile its FlatList.
export const MobileCommitTimeline = memo(function MobileCommitTimeline({
  client,
  connState,
  worktreeId,
  hostId,
  bottomInset,
  refreshNonce = 0,
  settled,
  baseRef,
  baseMergeBase,
  base,
  headKey,
  upstream,
  uncommitted,
  pushAction,
  actionError,
  onOpenChanges
}: Props) {
  const colorScheme = useMobileColorScheme()
  const t = useMobileTranslation()
  const forceReconnect = useForceReconnect()
  // Keep the fetched page, not formatted rows, so times follow a language switch.
  const [loaded, setLoaded] = useState<{
    tree: string
    page: { result: MobileGitHistoryResult; nowMs: number } | null
    error: string | null
  } | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  // Retained segments must never show another tree’s history, even offline before a refetch.
  const tree = `${hostId}\0${worktreeId}`
  const current = loaded?.tree === tree ? loaded : null
  const page = current?.page ?? null
  const error = current?.error ?? null

  useEffect(() => {
    let active = true
    if (!client || connState !== 'connected' || !worktreeId || !settled) {
      // Keep loaded rows visible through disconnection.
      return
    }
    // Clear error precedence for retries, retaining rows until fresh history arrives.
    setLoaded((prev) => (prev?.tree === tree ? { ...prev, error: null } : prev))
    void (async () => {
      try {
        const result = await fetchMobileGitHistory(client, worktreeId, baseRef)
        if (active) {
          setLoaded({ tree, page: { result, nowMs: Date.now() }, error: null })
        }
      } catch (err) {
        if (active) {
          const message =
            err instanceof Error
              ? err.message
              : translate('sourceControl.gitHistoryList.loadFailed', 'Failed to load history')
          setLoaded((prev) => ({
            tree,
            page: prev?.tree === tree ? prev.page : null,
            error: message
          }))
        }
      }
    })()
    return () => {
      active = false
    }
  }, [baseRef, client, connState, headKey, reloadNonce, refreshNonce, settled, tree, worktreeId])

  const hasUncommittedChanges = (uncommitted?.fileCount ?? 0) > 0
  const timeline = useMemo(() => {
    if (!page) {
      return null
    }
    const todayStartMs = startOfLocalDay(page.nowMs)
    return {
      todayStartMs,
      rows: buildMobileCommitTimeline({
        result: page.result,
        hasUncommittedChanges,
        baseMergeBase,
        upstream,
        startOfDay: startOfLocalDay,
        todayStartMs
      })
    }
  }, [baseMergeBase, hasUncommittedChanges, page, upstream])

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
          setLoaded((prev) => (prev?.tree === tree ? { ...prev, error: null } : prev))
          retryAction()
        }

  const nowMs = page?.nowMs ?? 0
  const todayStartMs = timeline?.todayStartMs ?? 0
  const historyLimit = page?.result.limit ?? GIT_HISTORY_DEFAULT_LIMIT
  const renderRow = useCallback(
    ({ item }: { item: MobileTimelineRow }) => (
      <MobileCommitTimelineRow
        row={item}
        uncommitted={uncommitted}
        base={base}
        pushAction={pushAction}
        nowMs={nowMs}
        todayStartMs={todayStartMs}
        historyLimit={historyLimit}
        onOpenChanges={onOpenChanges}
      />
    ),
    // t: times and day names follow a language switch.
    [base, historyLimit, nowMs, onOpenChanges, pushAction, t, todayStartMs, uncommitted]
  )

  const connected = client !== null && connState === 'connected'
  const view = resolveMobileHistoryScreenView({ connected, rows: timeline?.rows ?? null, error })

  if (view.kind === 'error' || view.kind === 'waiting') {
    return (
      <MobileLoadErrorState
        message={
          view.kind === 'waiting'
            ? t('sourceControl.gitHistoryList.waitingForDesktop', 'Waiting for desktop...')
            : view.message
        }
        onRetry={retry}
      />
    )
  }
  if (view.kind === 'loading') {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (view.kind === 'empty') {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>
          {t('sourceControl.gitHistoryList.noCommits', 'No commits.')}
        </Text>
      </View>
    )
  }
  return (
    <FlatList
      data={view.rows}
      extraData={colorScheme}
      renderItem={renderRow}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={
        actionError ? (
          <View style={listStyles.actionError}>
            <Text style={listStyles.actionErrorText} numberOfLines={3}>
              {actionError}
            </Text>
          </View>
        ) : null
      }
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl + bottomInset }}
    />
  )
})

const styles = themedStyleSheet(() => ({
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  stateText: { color: colors.textMuted, fontSize: typography.bodySize }
}))
