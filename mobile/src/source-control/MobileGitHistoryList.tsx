import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
import type { MobileGitHistoryResult } from './git-history-reply-schema'

type CommitFilesState = {
  files?: MobileGitChangedFile[]
  error?: string
}

type Props = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  // Retry must revive a parked reconnect loop.
  hostId: string
  bottomInset: number
  refreshNonce?: number
}

// Memoize the hidden, mounted history list so commit-message keystrokes do not reconcile its FlatList.
export const MobileGitHistoryList = memo(function MobileGitHistoryList({
  client,
  connState,
  worktreeId,
  hostId,
  bottomInset,
  refreshNonce = 0
}: Props) {
  const colorScheme = useMobileColorScheme()
  const t = useMobileTranslation()
  const forceReconnect = useForceReconnect()
  // Keep the fetched page, not formatted rows, so relative times follow a language switch.
  const [rows, setRows] = useState<{ result: MobileGitHistoryResult; nowMs: number } | null>(null)
  const commitRows = useMemo(
    () => (rows ? mapMobileCommitRows(rows.result, rows.nowMs) : null),
    [rows, t]
  )
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesById, setFilesById] = useState<Record<string, CommitFilesState>>({})
  const [filesReloadNonce, setFilesReloadNonce] = useState(0)

  // Clear on host/worktree switches even offline; retained segments must never show another tree’s history.
  useEffect(() => {
    setRows(null)
    setError(null)
    setExpanded(null)
    setFilesById({})
  }, [hostId, worktreeId])

  useEffect(() => {
    let active = true
    if (!client || connState !== 'connected' || !worktreeId) {
      // Keep loaded rows and expansion state visible through disconnection.
      return
    }
    // Clear error precedence for retries, retaining rows until fresh history arrives.
    setError(null)
    void (async () => {
      try {
        const result = await fetchMobileGitHistory(client, worktreeId)
        if (active) {
          setRows({ result, nowMs: Date.now() })
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : translate('sourceControl.gitHistoryList.loadFailed', 'Failed to load history')
          )
        }
      }
    })()
    return () => {
      active = false
    }
  }, [client, connState, reloadNonce, refreshNonce, worktreeId])

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

  const toggleCommit = useCallback((row: MobileCommitRow) => {
    setExpanded((current) => (current === row.id ? null : row.id))
  }, [])

  // Load in an effect so expansion during an outage retries on reconnect rather than caching the outage.
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
              error:
                err instanceof Error
                  ? err.message
                  : translate(
                      'sourceControl.gitHistoryList.loadFilesFailed',
                      'Unable to load commit files'
                    )
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
              {filesState?.error ? (
                <View>
                  <Text style={styles.empty}>{filesState.error}</Text>
                  {connected || retryAction ? (
                    <Pressable
                      style={styles.retryButton}
                      accessibilityLabel={t(
                        'sourceControl.gitHistoryList.retryFiles',
                        'Retry commit files'
                      )}
                      onPress={() => {
                        if (connState !== 'connected') {
                          retryAction?.()
                        } else {
                          setFilesReloadNonce((value) => value + 1)
                        }
                      }}
                    >
                      <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              {files === undefined && !filesState?.error ? (
                connected ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Text style={styles.empty}>
                    {t('sourceControl.gitHistoryList.waitingForDesktop', 'Waiting for desktop...')}
                  </Text>
                )
              ) : null}
              {files !== undefined ? (
                files.length === 0 ? (
                  <Text style={styles.empty}>
                    {t('sourceControl.gitHistoryList.noFileChanges', 'No file changes')}
                  </Text>
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
                )
              ) : null}
            </View>
          ) : null}
        </View>
      )
    },
    [colorScheme, connected, connState, expanded, filesById, retryAction, toggleCommit, t]
  )

  const view = resolveMobileHistoryScreenView({ connected, rows: commitRows, error })

  if (view.kind === 'error' || view.kind === 'waiting') {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>
          {view.kind === 'waiting'
            ? t('sourceControl.gitHistoryList.waitingForDesktop', 'Waiting for desktop...')
            : view.message}
        </Text>
        {retry ? (
          <Pressable
            style={styles.retryButton}
            onPress={retry}
            accessibilityLabel={t('common.retry', 'Retry')}
          >
            <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
          </Pressable>
        ) : null}
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
      renderItem={renderCommit}
      keyExtractor={(row) => row.id}
      contentContainerStyle={{ paddingBottom: spacing.lg + bottomInset }}
    />
  )
})

const styles = themedStyleSheet(() => ({
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
}))
