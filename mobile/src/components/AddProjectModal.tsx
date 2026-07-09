import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { ArrowUp, ChevronRight, Folder, FolderGit2, FolderPlus } from 'lucide-react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { DirEntry } from '../../../src/shared/types'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'

type BrowseListing = {
  resolvedPath: string
  entries: DirEntry[]
}

// Why: folders like node_modules can hold thousands of entries; cap what a
// single drawer renders so a stray tap doesn't hang the JS thread.
const MAX_VISIBLE_DIRECTORIES = 300

function isFilesystemRoot(path: string): boolean {
  return path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)
}

function folderBasename(path: string): string {
  return /([^\\/]+)[\\/]*$/.exec(path)?.[1] ?? path
}

type IconButtonProps = {
  connected: boolean
  onPress: () => void
  style: StyleProp<ViewStyle>
  iconSize?: number
}

export function AddProjectIconButton({
  connected,
  onPress,
  style,
  iconSize = 16
}: IconButtonProps) {
  return (
    <Pressable
      style={[style, !connected && styles.iconButtonDisabled]}
      onPress={onPress}
      disabled={!connected}
      accessibilityRole="button"
      accessibilityLabel="Add project"
    >
      <FolderPlus size={iconSize} color={connected ? colors.textSecondary : colors.textMuted} />
    </Pressable>
  )
}

type Props = {
  visible: boolean
  client: RpcClient | null
  onAdded: () => void
  onClose: () => void
}

// Why: mobile has no native picker for the host's filesystem, so this drawer
// browses it remotely via files.browseServerDir (the same RPC desktop uses
// for SSH/runtime hosts) and registers the picked folder with repo.add.
export function AddProjectModal({ visible, client, onAdded, onClose }: Props) {
  const [listing, setListing] = useState<BrowseListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const requestEpochRef = useRef(0)
  // Why: each drawer opening is a distinct session. An in-flight repo.add from
  // a previous opening must not close/refresh the freshly reopened modal.
  const sessionEpochRef = useRef(0)

  const browse = useCallback(
    async (target: string) => {
      if (!client) {
        return
      }
      const epoch = ++requestEpochRef.current
      setLoading(true)
      setError('')
      try {
        const response = await client.sendRequest(
          'files.browseServerDir',
          { path: target },
          { timeoutMs: 15_000 }
        )
        if (requestEpochRef.current !== epoch) {
          return
        }
        if (!response.ok) {
          setError(response.error.message)
          return
        }
        setListing((response as RpcSuccess).result as BrowseListing)
      } catch (e) {
        if (requestEpochRef.current === epoch) {
          setError(e instanceof Error ? e.message : 'Failed to browse host folders')
        }
      } finally {
        if (requestEpochRef.current === epoch) {
          setLoading(false)
        }
      }
    },
    [client]
  )

  useEffect(() => {
    if (!visible) {
      return
    }
    // Each open is a fresh session starting from the host user's home.
    sessionEpochRef.current += 1
    setListing(null)
    setAdding(false)
    void browse('~')
  }, [visible, browse])

  const path = listing?.resolvedPath ?? null
  // Why: .git can be a directory or a file (worktrees/submodules); either
  // marks the folder as a git repo, which picks repo.add's kind.
  const isGitRepo = listing?.entries.some((entry) => entry.name === '.git') ?? false
  const directories = (listing?.entries ?? []).filter(
    (entry) => entry.isDirectory && !entry.name.startsWith('.')
  )
  const visibleDirectories = directories.slice(0, MAX_VISIBLE_DIRECTORIES)
  const hasUpRow = path != null && !isFilesystemRoot(path)
  const canAdd = path != null && !adding && !loading

  async function handleAdd() {
    if (!client || !path) {
      return
    }
    const session = sessionEpochRef.current
    setAdding(true)
    setError('')
    try {
      const response = await client.sendRequest(
        'repo.add',
        { path, kind: isGitRepo ? 'git' : 'folder' },
        { timeoutMs: 30_000 }
      )
      if (sessionEpochRef.current !== session) {
        return
      }
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      onClose()
      onAdded()
    } catch (e) {
      if (sessionEpochRef.current === session) {
        setError(e instanceof Error ? e.message : 'Failed to add project')
      }
    } finally {
      if (sessionEpochRef.current === session) {
        setAdding(false)
      }
    }
  }

  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={styles.title}>Add Project</Text>
        <Text style={styles.subtitle}>Pick a folder on the host to add as a project.</Text>
      </View>

      <View style={styles.pathRow}>
        <Text style={styles.pathText} numberOfLines={1} ellipsizeMode="middle">
          {path ?? ' '}
        </Text>
        {loading && listing ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : null}
      </View>

      <View style={styles.listGroup}>
        {listing == null ? (
          <View style={styles.loadingContainer}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Text style={styles.emptyText}>Unable to browse host folders</Text>
            )}
          </View>
        ) : (
          <>
            {hasUpRow ? (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                // Why: the server resolves paths with platform-native
                // path.resolve, and Windows accepts mixed separators, so
                // joining with '/' is safe for both hosts.
                onPress={() => void browse(`${path}/..`)}
              >
                <ArrowUp size={14} color={colors.textSecondary} />
                <Text style={styles.rowText} numberOfLines={1}>
                  ..
                </Text>
              </Pressable>
            ) : null}
            {visibleDirectories.map((entry, i) => (
              <View key={entry.name}>
                {(hasUpRow || i > 0) && <View style={styles.rowSeparator} />}
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => void browse(`${path}/${entry.name}`)}
                >
                  <Folder size={14} color={colors.textSecondary} />
                  <Text style={styles.rowText} numberOfLines={1}>
                    {entry.name}
                  </Text>
                  <ChevronRight size={14} color={colors.textMuted} />
                </Pressable>
              </View>
            ))}
            {directories.length > visibleDirectories.length ? (
              <Text style={styles.truncatedText}>
                Showing {visibleDirectories.length} of {directories.length} folders
              </Text>
            ) : null}
            {directories.length === 0 ? (
              <Text style={styles.emptyDirText}>No subfolders</Text>
            ) : null}
          </>
        )}
      </View>

      {listing != null ? (
        <View style={styles.kindHint}>
          {isGitRepo ? (
            <FolderGit2 size={14} color={colors.statusGreen} />
          ) : (
            <Folder size={14} color={colors.textMuted} />
          )}
          <Text style={styles.kindHintText}>
            {isGitRepo ? 'Git repository' : 'Not a git repository — added as a folder project'}
          </Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          style={[styles.addButton, !canAdd && styles.addButtonDisabled]}
          disabled={!canAdd}
          onPress={() => void handleAdd()}
        >
          {adding ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.addText} numberOfLines={1}>
              {path ? `Add "${folderBasename(path)}"` : 'Add'}
            </Text>
          )}
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  iconButtonDisabled: {
    opacity: 0.6
  },
  header: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  subtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.sm
  },
  pathText: {
    flex: 1,
    fontSize: 12,
    fontFamily: typography.monoFamily,
    color: colors.textSecondary
  },
  listGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    overflow: 'hidden',
    marginBottom: spacing.md
  },
  loadingContainer: {
    paddingVertical: spacing.xl,
    alignItems: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  emptyDirText: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  truncatedText: {
    color: colors.textMuted,
    fontSize: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md + 2
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  rowSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  kindHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.sm
  },
  kindHintText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary
  },
  error: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.md
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm
  },
  addButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    minWidth: 160,
    maxWidth: '100%',
    alignItems: 'center'
  },
  addButtonDisabled: {
    opacity: 0.4
  },
  addText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
