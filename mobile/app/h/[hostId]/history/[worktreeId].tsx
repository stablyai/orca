import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react-native'
import { useHostClient } from '../../../../src/transport/client-context'
import type { RpcSuccess } from '../../../../src/transport/types'
import { colors, spacing, typography } from '../../../../src/theme/mobile-theme'
import {
  fetchMobileGitHistory,
  mapMobileCommitRows,
  type MobileCommitRow
} from '../../../../src/source-control/mobile-git-history'
import type { GitBranchChangeEntry } from '../../../../../src/shared/types'

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export default function HistoryScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { client, state: connState } = useHostClient(hostId)

  const [rows, setRows] = useState<MobileCommitRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesById, setFilesById] = useState<Record<string, GitBranchChangeEntry[] | 'loading'>>({})

  useEffect(() => {
    let active = true
    if (!client || connState !== 'connected' || !worktreeId) {
      return
    }
    // Reset prior error/rows so a successful retry doesn't stay stuck behind a
    // stale error (error wins render precedence).
    setError(null)
    setRows(null)
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
  }, [client, connState, worktreeId])

  const toggleCommit = useCallback(
    (row: MobileCommitRow) => {
      const next = expanded === row.id ? null : row.id
      setExpanded(next)
      if (next && client && !filesById[row.id]) {
        setFilesById((prev) => ({ ...prev, [row.id]: 'loading' }))
        void client
          .sendRequest('git.commitCompare', { worktree: `id:${worktreeId}`, commitId: row.id })
          .then((response) => {
            const entries = response.ok
              ? ((response as RpcSuccess).result as { entries: GitBranchChangeEntry[] }).entries
              : []
            setFilesById((prev) => ({ ...prev, [row.id]: entries }))
          })
          .catch(() => setFilesById((prev) => ({ ...prev, [row.id]: [] })))
      }
    },
    [client, expanded, filesById, worktreeId]
  )

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
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : files.length === 0 ? (
                <Text style={styles.empty}>No file changes</Text>
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
    [expanded, filesById, toggleCommit]
  )

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable style={styles.back} onPress={() => router.back()} accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.title}>Commit History</Text>
      </View>
      {error ? (
        <View style={styles.state}>
          <Text style={styles.stateText}>{error}</Text>
        </View>
      ) : rows === null ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.stateText}>No commits.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          renderItem={renderCommit}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{ paddingBottom: spacing.lg + insets.bottom }}
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm
  },
  back: { padding: spacing.xs },
  title: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  stateText: { color: colors.textMuted, fontSize: typography.bodySize },
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
