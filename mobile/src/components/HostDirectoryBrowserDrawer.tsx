import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native'
import { ArrowUp, File, Folder, Home } from 'lucide-react-native'

import { colors } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import { BottomDrawer } from './BottomDrawer'
import { hostDirectoryBrowserStyles as styles } from './host-directory-browser-styles'
import {
  isAtHostBrowseRoot,
  isDrivePath,
  joinHostBrowsePath,
  parentHostBrowsePath,
  type HostPathFlavor
} from './host-directory-browser-paths'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'
import {
  newWorkspaceAddRepoOperation,
  newWorkspaceBrowseServerDirOperation
} from './new-workspace-operations'

type DirectoryEntry = {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
}

export type HostDirectoryBrowserDrawerProps = {
  visible: boolean
  client: RpcClient | null
  onClose: () => void
  onAdded: (repo: MobileWorkspaceRepo) => void | Promise<void>
}

export function HostDirectoryBrowserDrawer({
  visible,
  client,
  onClose,
  onAdded
}: HostDirectoryBrowserDrawerProps) {
  const [resolvedPath, setResolvedPath] = useState('')
  const [pathFlavor, setPathFlavor] = useState<HostPathFlavor>('posix')
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [pathInput, setPathInput] = useState('')
  const [kind, setKind] = useState<'git' | 'folder'>('git')
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const requestIdRef = useRef(0)

  const browseTo = useCallback(
    async (targetPath: string) => {
      if (!client) {
        return
      }
      const requestId = ++requestIdRef.current
      setLoading(true)
      setError('')
      try {
        const reply = await newWorkspaceBrowseServerDirOperation.request(client, {
          path: targetPath
        })
        const result = newWorkspaceBrowseServerDirOperation.interpret(reply)
        if (requestId !== requestIdRef.current) {
          return
        }
        setResolvedPath(result.resolvedPath)
        setPathFlavor(result.pathFlavor)
        setEntries(result.entries)
        setPathInput('')
      } catch (err) {
        if (requestId === requestIdRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (requestId === requestIdRef.current) {
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
    void browseTo('~')
  }, [visible, browseTo])

  const isDirectPath = useMemo(() => {
    const trimmed = pathInput.trim()
    return trimmed.startsWith('/') || trimmed.startsWith('~') || isDrivePath(trimmed)
  }, [pathInput])

  const filteredEntries = useMemo(() => {
    const trimmed = pathInput.trim()
    if (isDirectPath || trimmed === '') {
      return entries
    }
    const query = trimmed.toLowerCase()
    return entries.filter((entry) => entry.name.toLowerCase().includes(query))
  }, [entries, isDirectPath, pathInput])

  const atRoot = isAtHostBrowseRoot(resolvedPath)
  const canAdd = Boolean(client && resolvedPath && !atRoot && !loading)

  async function handleAddProject() {
    if (!canAdd || !client || loading) {
      return
    }
    setAdding(true)
    setError('')
    try {
      const reply = await newWorkspaceAddRepoOperation.request(client, {
        path: resolvedPath,
        kind
      })
      const result = newWorkspaceAddRepoOperation.interpret(reply)
      await onAdded(result.repo)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  function handlePathSubmit() {
    const trimmed = pathInput.trim()
    if (isDirectPath && !loading) {
      void browseTo(trimmed)
    }
  }

  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      dragContentToDismiss={false}
      contentScrollable={false}
    >
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Add project</Text>
          <View style={styles.navActions}>
            <Pressable
              accessibilityLabel="Up"
              style={[styles.navButton, (atRoot || loading) && styles.buttonDisabled]}
              disabled={atRoot || loading}
              onPress={() => void browseTo(parentHostBrowsePath(resolvedPath, pathFlavor))}
            >
              <ArrowUp size={16} color={atRoot ? colors.textMuted : colors.textPrimary} />
            </Pressable>
            <Pressable
              accessibilityLabel="Home"
              style={[styles.navButton, loading && styles.buttonDisabled]}
              disabled={loading}
              onPress={() => void browseTo('~')}
            >
              <Home size={16} color={colors.textPrimary} />
            </Pressable>
          </View>
        </View>
        <Text style={styles.currentPath} numberOfLines={1}>
          {resolvedPath || '~'}
        </Text>
      </View>

      <TextInput
        style={styles.searchInput}
        value={pathInput}
        onChangeText={setPathInput}
        onSubmitEditing={handlePathSubmit}
        placeholder="Filter entries or type path (/..., C:\...)"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
      />

      <View style={styles.listContainer}>
        {loading ? (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : filteredEntries.length === 0 ? (
          <View style={styles.centeredContent}>
            <Text style={styles.emptyText}>No entries found</Text>
          </View>
        ) : (
          <FlatList
            data={filteredEntries}
            keyExtractor={(item) => item.name}
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            ItemSeparatorComponent={ItemSeparator}
            renderItem={({ item }) => {
              if (item.isDirectory) {
                return (
                  <Pressable
                    style={({ pressed }) => [styles.entryRow, pressed && styles.entryRowPressed]}
                    onPress={() =>
                      void browseTo(joinHostBrowsePath(resolvedPath, item.name, pathFlavor))
                    }
                  >
                    <Folder size={16} color={colors.accentBlue} />
                    <Text style={styles.entryTextDirectory} numberOfLines={1}>
                      {item.name}
                    </Text>
                  </Pressable>
                )
              }
              return (
                <View style={[styles.entryRow, styles.entryRowDimmed]}>
                  <File size={16} color={colors.textMuted} />
                  <Text style={styles.entryTextFile} numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
              )
            }}
          />
        )}
      </View>

      <View style={styles.controls}>
        <View style={styles.kindToggle}>
          <Pressable
            style={[styles.kindButton, kind === 'git' && styles.kindButtonActive]}
            onPress={() => setKind('git')}
          >
            <Text style={[styles.kindButtonText, kind === 'git' && styles.kindButtonTextActive]}>
              Git
            </Text>
          </Pressable>
          <Pressable
            style={[styles.kindButton, kind === 'folder' && styles.kindButtonActive]}
            onPress={() => setKind('folder')}
          >
            <Text style={[styles.kindButtonText, kind === 'folder' && styles.kindButtonTextActive]}>
              Folder
            </Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.addButton, (!canAdd || adding) && styles.buttonDisabled]}
          disabled={!canAdd || adding}
          onPress={() => void handleAddProject()}
        >
          {adding ? (
            <ActivityIndicator size="small" color={colors.bgBase} />
          ) : (
            <Text style={styles.addButtonText}>Add project</Text>
          )}
        </Pressable>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </BottomDrawer>
  )
}

function ItemSeparator() {
  return <View style={styles.separator} />
}
