import { memo, useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { ConnectionState, RpcSuccess } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useForceReconnect } from '../transport/client-context'
import {
  fetchMobileGitHistory,
  mapMobileCommitRows,
  type MobileCommitRow
} from './mobile-git-history'
import { resolveMobileHistoryScreenView } from './mobile-history-screen-state'
import type { GitBranchChangeEntry } from '../../../src/shared/types'
import { t } from '@/i18n/mobile-i18n'

type Props = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  // Needed so Retry can revive a parked reconnect loop (STA-1511 / #5049).
  hostId: string
  bottomInset: number
  // Bumped by the hub header refresh so History reloads without remounting.
  refreshNonce?: number
}

// Headerless commit-history list. Extracted from the /history route so the hub's
// History segment and the standalone route render the same body over one code path.
// Memoized: it stays mounted (hidden) while the Changes segment is active, and must
// not re-reconcile its FlatList on every commit-message keystroke re-render.
export const MobileGitHistoryList = memo(function MobileGitHistoryList({
  client,
  connState,
  worktreeId,
  hostId,
  bottomInset,
  refreshNonce = 0
}: Props) {
  const forceReconnect = useForceReconnect()
  const [rows, setRows] = useState<MobileCommitRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesById, setFilesById] = useState<Record<string, GitBranchChangeEntry[] | 'loading'>>({})

  // Host or worktree identity change must wipe history immediately — even while
  // disconnected — so a kept-mounted hub segment never shows another tree's commits.
  useEffect(() => {
    setRows(null)
    setError(null)
    setExpanded(null)
    setFilesById({})
  }, [hostId, worktreeId])

  useEffect(() => {
    let active = true
    if (!client || connState !== 'connected' || !worktreeId) {
      // Why: leave already-loaded rows (and expand state) alone across a drop —
      // resolveMobileHistoryScreenView keeps them visible (STA-1511).
      return
    }
    // Why (F10): clear only the error (it wins render precedence, so a stale one would outlive a
    // successful retry) — the loaded rows stay up until fresh ones land instead of flashing empty.
    setError(null)
    void (async () => {
      try {
        const result = await fetchMobileGitHistory(client, worktreeId)
        if (active) {
          setRows(mapMobileCommitRows(result, Date.now()))
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : t('mobileGitHistoryList.failed'))
        }
      }
    })()
    return () => {
      active = false
    }
  }, [client, connState, reloadNonce, refreshNonce, worktreeId])

  const retry = useCallback(() => {
    setError(null)
    // Why: retrying the fetch is useless while the transport's reconnect loop
    // is parked at its backoff cap — revive the connection instead (mirrors
    // MobileSourceControlPanel / issue #5049). The load effect re-runs via
    // connState once the fresh client connects.
    if (connState !== 'connected' && hostId) {
      void forceReconnect(hostId)
      return
    }
    setReloadNonce((n) => n + 1)
  }, [connState, forceReconnect, hostId])

  const toggleCommit = useCallback((row: MobileCommitRow) => {
    setExpanded((current) => (current === row.id ? null : row.id))
  }, [])

  // Why (F10): the expanded commit's files load here, not in the tap handler, so a row expanded
  // during an outage refetches on reconnect instead of caching the outage's answer forever.
  useEffect(() => {
    if (!expanded || !client || connState !== 'connected') {
      return
    }
    const commitId = expanded
    let stale = false
    setFilesById((prev) => (prev[commitId] ? prev : { ...prev, [commitId]: 'loading' }))
    void client
      .sendRequest('git.commitCompare', { worktree: `id:${worktreeId}`, commitId })
      .then((response) => {
        const entries = response.ok
          ? ((response as RpcSuccess).result as { entries: GitBranchChangeEntry[] }).entries
          : []
        if (!stale) {
          setFilesById((prev) => ({ ...prev, [commitId]: entries }))
        }
      })
      .catch(() => {
        // Keep an already-loaded list; a first load that fails resolves to "No file changes".
        if (!stale) {
          setFilesById((prev) =>
            prev[commitId] === 'loading' ? { ...prev, [commitId]: [] } : prev
          )
        }
      })
    return () => {
      stale = true
    }
  }, [client, connState, expanded, worktreeId])

  const connected = client !== null && connState === 'connected'

  const renderCommit = useCallback(
    ({ item }: { item: MobileCommitRow }) => {
      const files = filesById[item.id]
      const isOpen = expanded === item.id
      return (
        <View style={styles.commit}>
          <Pressable
            style={({ pressed }) => [styles.commitHeader, pressed && styles.commitHeaderPressed]}
            onPress={() => toggleCommit(item)}
          >
            {isOpen ? (
              <ChevronDown size={14} color={colors.textMuted} />
            ) : (
              <ChevronRight size={14} color={colors.textMuted} />
            )}
            <View style={styles.commitMain}>
              <Text style={styles.commitSubject} numberOfLines={1}>
                {item.subject}
              </Text>
              <Text style={styles.commitMeta} numberOfLines={1}>
                {item.shortId} · {item.author} · {item.relativeTime}
              </Text>
            </View>
          </Pressable>
          {isOpen ? (
            <View style={styles.files}>
              {files === 'loading' || files === undefined ? (
                // No request can complete while disconnected, so say so instead of spinning forever.
                connected ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Text style={styles.empty}>{t('mobileGitHistoryList.waiting')}</Text>
                )
              ) : files.length === 0 ? (
                <Text style={styles.empty}>{t('mobileGitHistoryList.noFile')}</Text>
              ) : (
                files.map((file) => (
                  <View key={file.path} style={styles.fileRow}>
                    <Text style={styles.filePath} numberOfLines={1}>
                      {file.path}
                    </Text>
                    <Text style={styles.fileStat}>
                      {file.added ? <Text style={styles.add}>+{file.added} </Text> : null}
                      {file.removed ? <Text style={styles.del}>-{file.removed}</Text> : null}
                    </Text>
                  </View>
                ))
              )}
            </View>
          ) : null}
        </View>
      )
    },
    [connected, expanded, filesById, toggleCommit]
  )

  const view = resolveMobileHistoryScreenView({ connected, rows, error })

  if (view.kind === 'error' || view.kind === 'waiting') {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>
          {view.kind === 'waiting' ? t('mobileGitHistoryList.waiting') : view.message}
        </Text>
        <Pressable
          style={styles.retryButton}
          onPress={retry}
          accessibilityLabel={t('mobileGitHistoryList.retry')}
        >
          <Text style={styles.retryText}>{t('mobileGitHistoryList.retry')}</Text>
        </Pressable>
      </View>
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
        <Text style={styles.stateText}>{t('mobileGitHistoryList.noCommits')}</Text>
      </View>
    )
  }
  return (
    <FlatList
      data={view.rows}
      renderItem={renderCommit}
      keyExtractor={(row) => row.id}
      contentContainerStyle={{ paddingBottom: spacing.lg + bottomInset }}
    />
  )
})

const styles = StyleSheet.create({
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  stateText: { color: colors.textMuted, fontSize: typography.bodySize },
  retryButton: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  retryText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  commit: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  commitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  commitHeaderPressed: { backgroundColor: colors.bgRaised },
  commitMain: { flex: 1, minWidth: 0 },
  commitSubject: { color: colors.textPrimary, fontSize: typography.bodySize },
  commitMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily,
    marginTop: 2
  },
  files: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 4 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  filePath: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  fileStat: { fontSize: typography.metaSize, fontFamily: typography.monoFamily },
  add: { color: colors.gitDecorationAdded },
  del: { color: colors.gitDecorationDeleted },
  empty: { color: colors.textMuted, fontSize: typography.metaSize }
})
