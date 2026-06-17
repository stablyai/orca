import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItem
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  Folder,
  Image as ImageIcon
} from 'lucide-react-native'
import { useHostClient, useForceReconnect } from '../../../../src/transport/client-context'
import { getWorktreeLabel } from '../../../../src/session/worktree-label'
import { classifyMobileArtifact } from '../../../../src/session/mobile-artifact-kind'
import {
  buildTree,
  flattenTree,
  isMarkdownPath,
  type FilesListResult,
  type MobileFileEntry,
  type TreeNode
} from '../../../../src/files/file-tree'
import type { RpcSuccess } from '../../../../src/transport/types'
import { triggerError, triggerSelection } from '../../../../src/platform/haptics'
import { colors, radii, spacing, typography } from '../../../../src/theme/mobile-theme'

export default function MobileFileExplorerScreen() {
  const { hostId, worktreeId, name } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
  }>()
  const router = useRouter()
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  const [files, setFiles] = useState<MobileFileEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

  const loadFiles = useCallback(async () => {
    if (!client || connState !== 'connected') {
      setLoading(false)
      setError(connState === 'connected' ? 'Connecting to desktop...' : 'Waiting for desktop...')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await client.sendRequest('files.list', { worktree: `id:${worktreeId}` })
      if (!response.ok) {
        throw new Error(response.error?.message || 'Unable to load files')
      }
      const result = (response as RpcSuccess).result as FilesListResult
      setFiles(result.files)
      setTruncated(result.truncated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load files')
    } finally {
      setLoading(false)
    }
  }, [client, connState, worktreeId])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const rows = useMemo(() => flattenTree(buildTree(files), expanded), [expanded, files])

  const toggleDirectory = useCallback((relativePath: string) => {
    triggerSelection()
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(relativePath)) {
        next.delete(relativePath)
      } else {
        next.add(relativePath)
      }
      return next
    })
  }, [])

  const openFile = useCallback(
    async (relativePath: string) => {
      if (!client) {
        return
      }
      setOpeningPath(relativePath)
      try {
        const response = await client.sendRequest('files.open', {
          worktree: `id:${worktreeId}`,
          relativePath
        })
        if (!response.ok) {
          throw new Error(response.error?.message || 'Unable to open file')
        }
        triggerSelection()
        router.back()
      } catch (err) {
        triggerError()
        setError(err instanceof Error ? err.message : 'Unable to open file')
      } finally {
        setOpeningPath(null)
      }
    },
    [client, router, worktreeId]
  )

  const renderItem: ListRenderItem<TreeNode> = ({ item }) => {
    const isDirectory = item.kind === 'directory'
    const isExpanded = expanded.has(item.relativePath)
    // Images render in the mobile viewer (via files.readPreview), so a binary
    // image is openable; only non-previewable binaries are unavailable.
    const isImage = item.kind === 'binary' && classifyMobileArtifact(item.relativePath) === 'image'
    const disabled = item.kind === 'binary' && !isImage
    const markdown = item.kind === 'text' && isMarkdownPath(item.relativePath)
    return (
      <Pressable
        style={({ pressed }) => [
          styles.row,
          { paddingLeft: spacing.lg + item.depth * 18 },
          pressed && !disabled && styles.rowPressed,
          disabled && styles.rowDisabled
        ]}
        disabled={disabled || openingPath !== null}
        onPress={() => {
          if (isDirectory) {
            toggleDirectory(item.relativePath)
          } else if (!disabled) {
            void openFile(item.relativePath)
          }
        }}
        accessibilityLabel={
          isDirectory
            ? `Open folder ${item.name}`
            : disabled
              ? `${item.name} unavailable on mobile`
              : `Open file ${item.name}`
        }
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown size={16} color={colors.textSecondary} />
          ) : (
            <ChevronRight size={16} color={colors.textSecondary} />
          )
        ) : (
          <View style={styles.chevronSpacer} />
        )}
        {isDirectory ? (
          <Folder size={17} color={colors.textSecondary} />
        ) : markdown ? (
          <FileText size={17} color={disabled ? colors.textMuted : colors.textSecondary} />
        ) : isImage ? (
          <ImageIcon size={17} color={colors.textSecondary} />
        ) : (
          <File size={17} color={disabled ? colors.textMuted : colors.textSecondary} />
        )}
        <View style={styles.rowTextBlock}>
          <Text style={[styles.rowTitle, disabled && styles.rowTitleDisabled]} numberOfLines={1}>
            {item.name}
          </Text>
          {disabled ? <Text style={styles.rowMeta}>Unavailable on mobile</Text> : null}
        </View>
        {openingPath === item.relativePath ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : null}
      </Pressable>
    )
  }

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityLabel="Back to session"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1}>
              Files
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {worktreeLabel}
              {truncated ? ' - Showing first 5000' : ''}
            </Text>
          </View>
        </View>
      </SafeAreaView>
      {loading ? (
        <View style={styles.state}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : error ? (
        <View style={styles.state}>
          <Text style={styles.errorText}>{error}</Text>
          {/* Why: while disconnected, re-sending the request is useless — revive
              the parked transport instead (issue #5049); loadFiles re-runs via
              its effect once the new client connects. */}
          <Pressable
            style={styles.retryButton}
            onPress={() =>
              connState !== 'connected' && hostId ? void forceReconnect(hostId) : void loadFiles()
            }
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.emptyText}>No files found</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          style={styles.list}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  topBar: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  backButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  titleBlock: {
    flex: 1,
    minWidth: 0
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600'
  },
  meta: {
    marginTop: 2,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  list: { flex: 1 },
  listContent: {
    paddingVertical: spacing.sm
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowDisabled: {
    opacity: 0.58
  },
  chevronSpacer: {
    width: 16
  },
  rowTextBlock: {
    flex: 1,
    minWidth: 0
  },
  rowTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  rowTitleDisabled: {
    color: colors.textMuted
  },
  rowMeta: {
    marginTop: 1,
    color: colors.textMuted,
    fontSize: 11
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    textAlign: 'center'
  },
  retryButton: {
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
