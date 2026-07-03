import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  Folder,
  Image as ImageIcon,
  X
} from 'lucide-react-native'
import { useHostClient, useForceReconnect } from '../transport/client-context'
import { getWorktreeLabel } from '../session/worktree-label'
import {
  buildTree,
  flattenTree,
  isMarkdownPath,
  type FilesListResult,
  type MobileFileEntry,
  type TreeNode
} from './file-tree'
import type { RpcSuccess } from '../transport/types'
import { triggerSelection } from '../platform/haptics'
import { colors, spacing } from '../theme/mobile-theme'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import {
  canPreviewMobileFileRow,
  navigateToMobileFilePreview
} from './mobile-file-preview-navigation'

export function MobileFileExplorerPanel(props: {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  onRequestClose?: () => void
}) {
  const { hostId, worktreeId, name, embedded, onRequestClose } = props
  const router = useRouter()
  const { client, state: connState } = useHostClient(hostId)
  const forceReconnect = useForceReconnect()
  const [files, setFiles] = useState<MobileFileEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

  const previewFile = useCallback(
    (relativePath: string, displayName: string) => {
      triggerSelection()
      navigateToMobileFilePreview(
        router,
        {
          hostId,
          worktreeId,
          relativePath,
          name: displayName,
          worktreeName: name
        },
        { embedded, onRequestClose }
      )
    },
    [embedded, hostId, name, onRequestClose, router, worktreeId]
  )

  const renderItem: ListRenderItem<TreeNode> = ({ item }) => {
    const isDirectory = item.kind === 'directory'
    const isExpanded = expanded.has(item.relativePath)
    // Images render in the mobile viewer (via files.readPreview), so a binary
    // image is openable; only non-previewable binaries are unavailable.
    const previewable =
      item.kind !== 'directory' &&
      canPreviewMobileFileRow({ kind: item.kind, relativePath: item.relativePath })
    const isImage = item.kind === 'binary' && previewable
    const disabled = item.kind === 'binary' && !previewable
    const markdown = item.kind === 'text' && isMarkdownPath(item.relativePath)
    return (
      <Pressable
        style={({ pressed }) => [
          styles.row,
          { paddingLeft: spacing.lg + item.depth * 18 },
          pressed && !disabled && styles.rowPressed,
          disabled && styles.rowDisabled
        ]}
        disabled={disabled}
        onPress={() => {
          if (isDirectory) {
            toggleDirectory(item.relativePath)
          } else if (!disabled) {
            previewFile(item.relativePath, item.name)
          }
        }}
        accessibilityLabel={
          isDirectory
            ? `Open folder ${item.name}`
            : disabled
              ? `${item.name} unavailable on mobile`
              : `Preview file ${item.name}`
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
      </Pressable>
    )
  }

  const headerBar = (
    <View style={styles.topBar}>
      {embedded ? (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => onRequestClose?.()}
          hitSlop={8}
          accessibilityLabel="Close files"
        >
          <X size={20} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Back to session"
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      )}
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
  )

  const body = loading ? (
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
  )

  // Embedded: the dock column owns safe-area/layout, so render a plain View and
  // a non-inset header. Full-screen: keep the SafeAreaView top inset + chrome.
  return (
    <View style={styles.container}>
      {embedded ? (
        <View style={styles.header}>{headerBar}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {headerBar}
        </SafeAreaView>
      )}
      {body}
    </View>
  )
}
