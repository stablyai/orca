import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { ArrowUp, ChevronRight, Folder, FolderGit2, FolderPlus } from 'lucide-react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import type { DirEntry } from '../../../src/shared/types'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { pathBasename } from './path-basename'

type BrowseListing = {
  resolvedPath: string
  entries: DirEntry[]
}

// Why: folders like node_modules can hold thousands of entries; even with a
// virtualized list, cap the rows so absurd folders stay responsive.
const MAX_VISIBLE_DIRECTORIES = 300

// Sentinel row for "go up one level"; a real entry can never be named "..".
const UP_ENTRY: DirEntry = { name: '..', isDirectory: true, isSymlink: false }

function isFilesystemRoot(path: string): boolean {
  return path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)
}

// Why: browse and add must both discard completions that land after their
// epoch was invalidated (a newer request, or the drawer being reopened) —
// one guard, parameterized by which epoch invalidates it.
async function runEpochGuardedRequest<T>(args: {
  epochRef: { current: number }
  epoch: number
  setBusy: (busy: boolean) => void
  setError: (message: string) => void
  fallbackError: string
  request: () => Promise<RpcResponse>
  onSuccess: (result: T) => void
}): Promise<void> {
  const { epochRef, epoch } = args
  args.setBusy(true)
  args.setError('')
  try {
    const response = await args.request()
    if (epochRef.current !== epoch) {
      return
    }
    if (!response.ok) {
      args.setError(response.error.message)
      return
    }
    args.onSuccess((response as RpcSuccess).result as T)
  } catch (e) {
    if (epochRef.current === epoch) {
      args.setError(e instanceof Error ? e.message : args.fallbackError)
    }
  } finally {
    if (epochRef.current === epoch) {
      args.setBusy(false)
    }
  }
}

type IconButtonProps = {
  connected: boolean
  onPress: () => void
  style: StyleProp<ViewStyle>
}

export function AddProjectIconButton({ connected, onPress, style }: IconButtonProps) {
  return (
    <Pressable
      style={[style, !connected && styles.iconButtonDisabled]}
      onPress={onPress}
      disabled={!connected}
      accessibilityRole="button"
      accessibilityLabel="Add project"
    >
      <FolderPlus size={16} color={connected ? colors.textSecondary : colors.textMuted} />
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
      await runEpochGuardedRequest<BrowseListing>({
        epochRef: requestEpochRef,
        epoch: ++requestEpochRef.current,
        setBusy: setLoading,
        setError,
        fallbackError: 'Failed to browse host folders',
        request: () =>
          client.sendRequest('files.browseServerDir', { path: target }, { timeoutMs: 15_000 }),
        onSuccess: setListing
      })
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
  const rows = hasUpRow ? [UP_ENTRY, ...visibleDirectories] : visibleDirectories
  const canAdd = path != null && !adding && !loading

  async function handleAdd() {
    if (!client || !path) {
      return
    }
    await runEpochGuardedRequest({
      epochRef: sessionEpochRef,
      epoch: sessionEpochRef.current,
      setBusy: setAdding,
      setError,
      fallbackError: 'Failed to add project',
      request: () =>
        client.sendRequest(
          'repo.add',
          { path, kind: isGitRepo ? 'git' : 'folder' },
          { timeoutMs: 30_000 }
        ),
      onSuccess: () => {
        onClose()
        onAdded()
      }
    })
  }

  const listFooter =
    directories.length === 0 ? (
      <Text style={styles.emptyDirText}>No subfolders</Text>
    ) : directories.length > visibleDirectories.length ? (
      <Text style={styles.truncatedText}>
        Showing {visibleDirectories.length} of {directories.length} folders
      </Text>
    ) : null

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      dragContentToDismiss={false}
      contentScrollable={false}
    >
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

      {listing == null ? (
        <View style={[styles.listGroup, styles.loadingContainer]}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={styles.emptyText}>Unable to browse host folders</Text>
          )}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(entry) => entry.name}
          style={styles.listGroup}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          ItemSeparatorComponent={RowSeparator}
          ListFooterComponent={listFooter}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              // Why: the server resolves paths with platform-native
              // path.resolve, and Windows accepts mixed separators, so
              // joining with '/' is safe for both hosts.
              onPress={() => void browse(`${path}/${item.name}`)}
            >
              {item === UP_ENTRY ? (
                <ArrowUp size={14} color={colors.textSecondary} />
              ) : (
                <Folder size={14} color={colors.textSecondary} />
              )}
              <Text style={styles.rowText} numberOfLines={1}>
                {item.name}
              </Text>
              {item === UP_ENTRY ? null : <ChevronRight size={14} color={colors.textMuted} />}
            </Pressable>
          )}
        />
      )}

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
              {path ? `Add "${pathBasename(path) || path}"` : 'Add'}
            </Text>
          )}
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

function RowSeparator() {
  return <View style={styles.rowSeparator} />
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
    // Why: the drawer content is static (contentScrollable={false}); bound the
    // list so it scrolls internally and the Add button stays reachable.
    maxHeight: 420,
    flexGrow: 0,
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
