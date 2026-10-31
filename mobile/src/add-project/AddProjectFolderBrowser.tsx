import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ChevronLeft, CornerLeftUp, Folder } from 'lucide-react-native'
import { joinCreateProjectPath } from '../../../src/shared/create-project-location'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { hostDirectoryBrowse, type AddProjectRpcSender } from './add-project-operations'
import type { HostDirectoryListing } from './add-project-reply-schema'
import { addProjectStyles } from './add-project-styles'

type Props = {
  client: AddProjectRpcSender
  startPath: string
  pickLabel: string
  onPick: (path: string) => void
  onBack: () => void
}

export function AddProjectFolderBrowser({ client, startPath, pickLabel, onPick, onBack }: Props) {
  const [listing, setListing] = useState<HostDirectoryListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const browse = useCallback(
    async (path: string, fallbackPath?: string) => {
      const request = ++requestRef.current
      setLoading(true)
      setError('')
      try {
        const next = hostDirectoryBrowse.interpret(
          await hostDirectoryBrowse.request(client, { path })
        )
        if (request === requestRef.current) {
          setListing(next)
        }
      } catch (caught) {
        // A missing start folder (e.g. a fresh host without ~/orca/projects) falls back to one that exists.
        if (fallbackPath && request === requestRef.current) {
          void browse(fallbackPath)
          return
        }
        // Keep the last listing so a folder that refuses to open does not strand the user.
        if (request === requestRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      } finally {
        if (request === requestRef.current) {
          setLoading(false)
        }
      }
    },
    [client]
  )

  useEffect(() => {
    const start = startPath.trim() || '~'
    void browse(start, start === '~' ? undefined : '~')
    return () => {
      requestRef.current += 1
    }
  }, [browse, startPath])

  const directories = listing?.entries.filter((entry) => entry.isDirectory) ?? []

  return (
    <View>
      <View style={styles.header}>
        <Pressable
          style={styles.iconButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.path} numberOfLines={2}>
          {listing?.resolvedPath ?? startPath}
        </Text>
        {loading ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
      </View>

      <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {listing ? (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => void browse(joinCreateProjectPath(listing.resolvedPath, '..'))}
            accessibilityRole="button"
            accessibilityLabel="Parent folder"
          >
            <CornerLeftUp size={16} color={colors.textSecondary} />
            <Text style={styles.rowText}>..</Text>
          </Pressable>
        ) : null}
        {directories.map((entry) => (
          <Pressable
            key={entry.name}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
              listing && void browse(joinCreateProjectPath(listing.resolvedPath, entry.name))
            }
            accessibilityRole="button"
          >
            <Folder size={16} color={colors.textSecondary} />
            <Text style={styles.rowText} numberOfLines={1}>
              {entry.name}
            </Text>
          </Pressable>
        ))}
        {listing && !loading && directories.length === 0 ? (
          <Text style={styles.empty}>No folders here</Text>
        ) : null}
      </ScrollView>

      {error ? <Text style={addProjectStyles.error}>{error}</Text> : null}

      <View style={addProjectStyles.actions}>
        <Pressable
          style={({ pressed }) => [
            addProjectStyles.submitButton,
            pressed && addProjectStyles.buttonPressed,
            !listing && addProjectStyles.submitButtonDisabled
          ]}
          disabled={!listing}
          onPress={() => listing && onPick(listing.resolvedPath)}
        >
          <Text style={addProjectStyles.submitText}>{pickLabel}</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm
  },
  iconButton: {
    padding: spacing.xs
  },
  path: {
    flex: 1,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  list: {
    maxHeight: 320,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  empty: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    padding: spacing.md
  }
})
