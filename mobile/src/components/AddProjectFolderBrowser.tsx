import { ChevronLeft, Folder, HardDrive } from 'lucide-react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { serverDirectoryBrowseRun } from '../tasks/repo-add-project-operations'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure } from '../transport/types'
import { newWorktreeFormStyles as formStyles } from './new-worktree-form-styles'

/**
 * The host-side folder picker behind "Browse folder". A phone cannot type a host path it has no
 * way to know, so the sheet walks the host's own filesystem instead — the same
 * `files.browseServerDir` listing the desktop folder picker uses.
 *
 * The listing is directory-only: a project has to be a folder, so files are never selectable.
 * Symlinks stay visible because the browse RPC follows them when it opens the target; a file or
 * broken symlink therefore refuses in the same request and leaves this listing intact.
 */

type FolderEntry = { name: string; isDirectory: boolean; isSymlink?: boolean }

type FolderListing = { path: string; entries: FolderEntry[] }

type Props = {
  client: RpcClient | null
  /** True while the parent is registering the picked folder, which disables navigation. */
  busy: boolean
  error: string
  onBack: () => void
  onPick: (path: string) => void
}

// The host resolves a blank path and "~" both to its own home directory.
const HOME_PATH = '~'

function separatorFor(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** Where a tapped row leads. A Windows drive row is already an absolute root ("C:\"). */
function childPathOf(parentPath: string, name: string): string {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    return name
  }
  return `${parentPath.replace(/[\\/]+$/, '')}${separatorFor(parentPath)}${name}`
}

/**
 * The listing to go up to, or null at the top. A Windows host answers a bare "/" with its
 * mounted-drive list, so a drive root goes up to that rather than off the top
 * (src/main/runtime/windows-drive-listing.ts:14-17).
 */
function parentPathOf(path: string): string | null {
  const separator = separatorFor(path)
  const trimmed = path.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return null
  }
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return '/'
  }
  const cut = trimmed.lastIndexOf(separator)
  if (cut === -1) {
    return null
  }
  const parent = trimmed.slice(0, cut)
  if (!parent) {
    return separator
  }
  // Keep the trailing separator on a drive root: "C:" alone is drive-relative on Windows.
  return /^[A-Za-z]:$/.test(parent) ? parent + separator : parent
}

export function AddProjectFolderBrowser({ client, busy, error, onBack, onPick }: Props) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const requestGeneration = useRef(0)
  const mounted = useRef(true)

  const open = useCallback(
    async (path: string) => {
      if (!client) {
        return
      }
      const generation = requestGeneration.current + 1
      requestGeneration.current = generation
      const requestClient = client
      setLoading(true)
      setLoadError('')
      try {
        const reply = await serverDirectoryBrowseRun.request(requestClient, { path })
        if (!mounted.current || generation !== requestGeneration.current) {
          return
        }
        const verdict = serverDirectoryBrowseRun.interpret(reply)
        if (!verdict.accepted) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unaccepted reply to a skip policy is a failure envelope.
          const refusal = (reply as RpcFailure).error
          setLoadError(refusal.message || refusal.code || 'Unable to read that folder')
          return
        }
        setListing({
          path: verdict.value.resolvedPath,
          entries: verdict.value.entries.filter((entry) => entry.isDirectory || entry.isSymlink)
        })
      } catch (error) {
        if (!mounted.current || generation !== requestGeneration.current) {
          return
        }
        // Why: a transport rejection mid-browse must land as copy, not leave the spinner up forever.
        setLoadError(error instanceof Error ? error.message : 'Unable to read that folder')
      } finally {
        if (mounted.current && generation === requestGeneration.current) {
          setLoading(false)
        }
      }
    },
    [client]
  )

  useEffect(() => {
    return () => {
      mounted.current = false
      requestGeneration.current += 1
    }
  }, [])

  useEffect(() => {
    requestGeneration.current += 1
    setListing(null)
    setLoadError('')
    setLoading(false)
    void open(HOME_PATH)
  }, [open])

  const currentPath = listing?.path ?? ''
  const parentPath = listing ? parentPathOf(listing.path) : null

  return (
    <View>
      <View style={styles.headerRow}>
        <Pressable
          style={styles.backButton}
          onPress={onBack}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Back to Add project"
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </Pressable>
        <Text style={formStyles.title}>Browse folder</Text>
      </View>

      <Text style={styles.path} numberOfLines={1} accessibilityLabel="Current folder">
        {currentPath || 'Home'}
      </Text>

      <View style={styles.list}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.textSecondary} style={styles.spinner} />
        ) : (
          <ScrollView>
            {parentPath ? (
              <Pressable
                style={styles.row}
                onPress={() => void open(parentPath)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Parent folder"
              >
                <ChevronLeft size={16} color={colors.textMuted} />
                <Text style={styles.rowLabel}>..</Text>
              </Pressable>
            ) : null}
            {listing?.entries.map((entry) => (
              <Pressable
                key={entry.name}
                style={styles.row}
                onPress={() => void open(childPathOf(currentPath, entry.name))}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={entry.name}
              >
                {/^[A-Za-z]:[\\/]/.test(entry.name) ? (
                  <HardDrive size={16} color={colors.textMuted} />
                ) : (
                  <Folder size={16} color={colors.textMuted} />
                )}
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {entry.name}
                </Text>
              </Pressable>
            ))}
            {listing && listing.entries.length === 0 ? (
              <Text style={styles.empty}>No folders here</Text>
            ) : null}
          </ScrollView>
        )}
      </View>

      {loadError ? <Text style={formStyles.error}>{loadError}</Text> : null}
      {error ? <Text style={formStyles.error}>{error}</Text> : null}

      <View style={formStyles.actions}>
        <Pressable
          style={[
            formStyles.createButton,
            (!currentPath || busy || loading) && formStyles.createButtonDisabled
          ]}
          disabled={!currentPath || busy || loading}
          onPress={() => onPick(currentPath)}
          accessibilityRole="button"
          accessibilityLabel="Add this folder as a project"
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={formStyles.createText}>Add this folder</Text>
          )}
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md
  },
  backButton: {
    marginLeft: -spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  path: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginBottom: spacing.sm
  },
  list: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgPanel,
    maxHeight: 260,
    minHeight: 120
  },
  spinner: {
    paddingVertical: spacing.lg
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md
  },
  rowLabel: {
    flexShrink: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  empty: {
    padding: spacing.md,
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
})
