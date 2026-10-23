import { memo, useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight, CloudOff, GitCommitHorizontal, History } from 'lucide-react-native'
import { colors, spacing, textStyles, typography } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { StateView } from '../components/ui/StateView'
import { slideTransition } from '../components/ui/transition-styles'
import { splitMobileFilePath } from './mobile-file-path-parts'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useForceReconnect } from '../transport/host-client-hooks'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { gitCommitCompareRead } from './mobile-git-read-operations'
import type { MobileGitChangedFile } from './git-compare-reply-schema'
import {
  fetchMobileGitHistory,
  mapMobileCommitRows,
  type MobileCommitRow
} from './mobile-git-history'
import { resolveMobileHistoryScreenView } from './mobile-history-screen-state'

type CommitFilesState = {
  files?: MobileGitChangedFile[]
  error?: string
}

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
  const [filesById, setFilesById] = useState<Record<string, CommitFilesState>>({})
  const [filesReloadNonce, setFilesReloadNonce] = useState(0)

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
          setError(err instanceof Error ? err.message : 'Failed to load history')
        }
      }
    })()
    return () => {
      active = false
    }
  }, [client, connState, reloadNonce, refreshNonce, worktreeId])

  // Why: retrying the fetch is useless while the transport's reconnect loop
  // is parked at its backoff cap — revive the connection instead (mirrors
  // MobileSourceControlPanel / issue #5049). The load effect re-runs via
  // connState once the fresh client connects.
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
    setFilesById((prev) => ({ ...prev, [commitId]: { files: prev[commitId]?.files } }))
    void gitCommitCompareRead
      .request(client, { worktree: `id:${worktreeId}`, commitId })
      .then((reply) => {
        const compared = gitCommitCompareRead.interpret(reply)
        if (!stale) {
          setFilesById((prev) => ({ ...prev, [commitId]: { files: compared.entries } }))
        }
      })
      .catch((err) => {
        if (!stale) {
          setFilesById((prev) => ({
            ...prev,
            [commitId]: {
              files: prev[commitId]?.files,
              error: err instanceof Error ? err.message : 'Unable to load commit files'
            }
          }))
        }
      })
    return () => {
      stale = true
    }
  }, [client, connState, expanded, filesReloadNonce, hostId, refreshNonce, worktreeId])

  const connected = client !== null && connState === 'connected'

  const renderCommit = useCallback(
    ({ item }: { item: MobileCommitRow }) => {
      const filesState = filesById[item.id]
      const files = filesState?.files
      const isOpen = expanded === item.id
      return (
        <View>
          <Pressable
            onPress={() => toggleCommit(item)}
            accessibilityRole="button"
            accessibilityLabel={`${item.subject}, ${item.shortId} by ${item.author}, ${item.relativeTime}`}
            accessibilityState={{ expanded: isOpen }}
          >
            {({ pressed }) => (
              <View style={[styles.commitHeader, pressed && styles.commitHeaderPressed]}>
                <View style={styles.commitMain}>
                  <Text style={styles.commitSubject} numberOfLines={2}>
                    {item.subject}
                  </Text>
                  <Text style={styles.commitMeta} numberOfLines={1}>
                    <Text style={styles.commitId}>{item.shortId}</Text> · {item.author} ·{' '}
                    {item.relativeTime}
                  </Text>
                </View>
                <View style={[isOpen ? styles.chevronOpen : styles.chevronClosed, slideTransition]}>
                  <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
                </View>
              </View>
            )}
          </Pressable>
          <Collapsible open={isOpen}>
            <View style={styles.files}>
              {filesState?.error ? (
                <View style={styles.filesNotice}>
                  <Text style={styles.empty}>{filesState.error}</Text>
                  {connected || retryAction ? (
                    <Button
                      label="Retry"
                      size="compact"
                      variant="secondary"
                      accessibilityLabel="Retry commit files"
                      onPress={() => {
                        if (connState !== 'connected') {
                          retryAction?.()
                        } else {
                          setFilesReloadNonce((value) => value + 1)
                        }
                      }}
                    />
                  ) : null}
                </View>
              ) : null}
              {files === undefined && !filesState?.error ? (
                connected ? (
                  <View style={styles.filesNotice}>
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  </View>
                ) : (
                  <Text style={styles.empty}>Waiting for desktop…</Text>
                )
              ) : null}
              {files !== undefined ? (
                files.length === 0 ? (
                  <Text style={styles.empty}>No file changes.</Text>
                ) : (
                  files.map((file) => {
                    const { name, directory } = splitMobileFilePath(file.path)
                    return (
                      <View
                        key={file.path}
                        style={styles.fileRow}
                        accessible
                        accessibilityLabel={`${file.path}, ${file.added ?? 0} added, ${file.removed ?? 0} removed`}
                      >
                        <View style={styles.fileText}>
                          <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
                            {name}
                          </Text>
                          {directory ? (
                            <Text style={styles.fileDir} numberOfLines={1} ellipsizeMode="head">
                              {directory}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.fileStat}>
                          {file.added ? <Text style={styles.add}>+{file.added} </Text> : null}
                          {file.removed ? <Text style={styles.del}>−{file.removed}</Text> : null}
                        </Text>
                      </View>
                    )
                  })
                )
              ) : null}
            </View>
          </Collapsible>
        </View>
      )
    },
    [connected, connState, expanded, filesById, retryAction, toggleCommit]
  )

  const view = resolveMobileHistoryScreenView({ connected, rows, error })

  if (view.kind === 'error' || view.kind === 'waiting') {
    return (
      <StateView
        icon={view.kind === 'waiting' ? CloudOff : History}
        title={view.kind === 'waiting' ? 'Waiting for desktop…' : 'Couldn’t load commits'}
        message={view.kind === 'waiting' ? undefined : view.message}
        primary={retry ? { label: 'Retry', onPress: retry } : undefined}
      />
    )
  }
  if (view.kind === 'loading') {
    return <StateView loading title="Loading commits…" />
  }
  if (view.kind === 'empty') {
    return (
      <StateView
        icon={GitCommitHorizontal}
        title="No commits"
        message="This branch has no commits yet."
      />
    )
  }
  return (
    <FlatList
      data={view.rows}
      renderItem={renderCommit}
      keyExtractor={(row) => row.id}
      ItemSeparatorComponent={CommitSeparator}
      contentContainerStyle={{ paddingBottom: spacing.lg + bottomInset }}
    />
  )
})

function CommitSeparator() {
  return <View style={styles.separator} />
}

const styles = StyleSheet.create({
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing.lg,
    backgroundColor: colors.separator
  },
  commitHeader: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10
  },
  commitHeaderPressed: { backgroundColor: colors.fill },
  commitMain: { flex: 1, minWidth: 0, gap: 2 },
  commitSubject: { ...textStyles.body, color: colors.textPrimary },
  commitMeta: { ...textStyles.footnote, color: colors.textMuted },
  commitId: { fontFamily: typography.monoFamily, fontVariant: ['tabular-nums'] },
  chevronClosed: { transform: [{ rotate: '0deg' }] },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  files: { paddingLeft: spacing.lg + spacing.md, paddingRight: spacing.lg, paddingBottom: 10 },
  filesNotice: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md
  },
  fileRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 4
  },
  fileText: { flex: 1, minWidth: 0 },
  fileName: { ...textStyles.callout, color: colors.textPrimary },
  fileDir: { ...textStyles.caption, color: colors.textMuted },
  fileStat: {
    ...textStyles.footnote,
    fontFamily: typography.monoFamily,
    fontVariant: ['tabular-nums']
  },
  add: { color: colors.gitDecorationAdded },
  del: { color: colors.gitDecorationDeleted },
  empty: { ...textStyles.callout, flexShrink: 1, color: colors.textSecondary, paddingVertical: 10 }
})
