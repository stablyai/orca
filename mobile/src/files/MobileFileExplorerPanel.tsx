import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, X } from 'lucide-react-native'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../navigation/workspace-route-handoff'
import { useForceReconnect } from '../transport/host-client-hooks'
import { useWorkspaceClient } from '../transport/use-workspace-client'
import { connectionRetryAction } from '../transport/connection-retry-action'
import { getWorktreeLabel } from '../session/worktree-label'
import {
  flattenDirectoryCache,
  getDirectoryCacheState,
  type DirectoryCache,
  type FileExplorerRow
} from './file-tree'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  beginDirectoryLoad,
  createDirectoryLoadRevisions,
  isCurrentDirectoryLoad,
  resetDirectoryLoadRevisions,
  type DirectoryLoadRevisions
} from './directory-load-revisions'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import { directoryCacheFromFileList } from './file-list-fallback'
import { fileDirectoryRead, legacyFileListRead } from './mobile-file-explorer-operations'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { MobileFileExplorerRow } from './mobile-file-explorer-row'
import { navigateToMobileFilePreview } from './mobile-file-preview-navigation'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function MobileFileExplorerPanel(props: {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  onRequestClose?: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { hostId, worktreeId, name, embedded, onRequestClose } = props
  const router = useWorkspaceRouteHandoff()
  const executionHost = useWorkspaceExecutionHost()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const scopeRef = useRef('')
  const scope = JSON.stringify([hostId, executionHost, worktreeId])
  scopeRef.current = scope
  const directoryLoadRevisionsRef = useRef<DirectoryLoadRevisions>(createDirectoryLoadRevisions())
  const pendingDirectoryRetriesRef = useRef<Set<string>>(new Set())
  const directoryCacheRef = useRef<DirectoryCache>({})
  const [panelWidth, setPanelWidth] = useState(0)
  const [directoryCache, setDirectoryCache] = useState<DirectoryCache>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [legacyListTruncated, setLegacyListTruncated] = useState(false)
  const worktreeLabel = getWorktreeLabel(name, worktreeId)

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      const scope = scopeRef.current
      const loadToken = beginDirectoryLoad(directoryLoadRevisionsRef.current, scope, relativePath)
      const rootLoad = relativePath === ''

      if (!client || connState !== 'connected') {
        const message =
          connState === 'connected'
            ? translate('files.fileExplorerPanel.connecting', 'Connecting to desktop...')
            : translate('files.fileExplorerPanel.waiting', 'Waiting for desktop...')
        if (rootLoad) {
          const hasLoadedRoot =
            (getDirectoryCacheState(directoryCacheRef.current, '')?.entries.length ?? 0) > 0
          setLoading(false)
          setError(hasLoadedRoot ? null : message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
        return
      }

      const hadLoadedRoot =
        rootLoad && (getDirectoryCacheState(directoryCacheRef.current, '')?.entries.length ?? 0) > 0
      if (rootLoad) {
        // Keep the cached tree during reconnect; a full-screen spinner unmounts the list and loses scroll.
        if (!hadLoadedRoot) {
          setLoading(true)
        }
        setError(null)
      }
      setDirectoryCache((prev) => ({
        ...prev,
        [relativePath]: {
          entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
          loading: true
        }
      }))

      try {
        const response = await fileDirectoryRead.request(client, {
          worktree: `id:${worktreeId}`,
          relativePath
        })
        const directory = fileDirectoryRead.interpret(response)
        if (!directory.accepted) {
          const refusal = response.ok ? undefined : response.error
          // Older desktops lack readDir in the mobile allowlist; fall back to capped files.list.
          if (rootLoad && isMobileMethodUnavailableError(refusal?.code, refusal?.message)) {
            const legacyReply = await legacyFileListRead.request(client, {
              worktree: `id:${worktreeId}`
            })
            const legacy = legacyFileListRead.interpret(legacyReply)
            if (legacy.accepted) {
              if (
                !isCurrentDirectoryLoad(
                  directoryLoadRevisionsRef.current,
                  scopeRef.current,
                  loadToken
                )
              ) {
                return
              }
              const legacyResult = legacy.value
              setDirectoryCache(directoryCacheFromFileList(legacyResult.files))
              // Keep the truncation note because the capped list silently omits later files.
              setLegacyListTruncated(legacyResult.truncated)
              return
            }
            throw new Error(
              (legacyReply.ok ? undefined : legacyReply.error)?.message ||
                refusal?.message ||
                translate('files.fileExplorerPanel.loadFailed', 'Unable to load files')
            )
          }
          throw new Error(
            refusal?.message ||
              translate('files.fileExplorerPanel.loadFailed', 'Unable to load files')
          )
        }
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          return
        }
        const entries = directory.value
        if (rootLoad) {
          setLegacyListTruncated(false)
        }
        setDirectoryCache((prev) => ({
          ...prev,
          [relativePath]: { entries }
        }))
        return 'directory' as const
      } catch (err) {
        if (
          !isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          return
        }
        const message =
          err instanceof Error
            ? err.message
            : translate('files.fileExplorerPanel.loadFailed', 'Unable to load files')
        if (rootLoad) {
          // Only cold loads show full-screen errors; failed background refreshes retain the cached tree.
          setError(hadLoadedRoot ? null : message)
        } else {
          setDirectoryCache((prev) => ({
            ...prev,
            [relativePath]: {
              entries: getDirectoryCacheState(prev, relativePath)?.entries ?? [],
              error: message
            }
          }))
        }
      } finally {
        if (
          rootLoad &&
          isCurrentDirectoryLoad(directoryLoadRevisionsRef.current, scopeRef.current, loadToken)
        ) {
          setLoading(false)
        }
      }
    },
    [client, connState, worktreeId]
  )

  useEffect(() => {
    scopeRef.current = scope
    resetDirectoryLoadRevisions(directoryLoadRevisionsRef.current)
    pendingDirectoryRetriesRef.current.clear()
    directoryCacheRef.current = {}
    setDirectoryCache({})
    setExpanded(new Set())
    setLoading(true)
    setError(null)
    setLegacyListTruncated(false)
  }, [scope])

  useEffect(() => {
    directoryCacheRef.current = directoryCache
  }, [directoryCache])

  const refreshExpandedDirectories = useEffectEvent(() => {
    setDirectoryCache((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([path]) => path === '' || expanded.has(path))
      )
    )
    for (const relativePath of expanded) {
      if (getDirectoryCacheState(directoryCacheRef.current, relativePath)) {
        void loadDirectory(relativePath)
      }
    }
  })

  useEffect(() => {
    let cancelled = false
    resetDirectoryLoadRevisions(directoryLoadRevisionsRef.current)
    setDirectoryCache((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([path, state]) => [
          path,
          state?.loading
            ? {
                entries: state.entries,
                error: translate(
                  'files.fileExplorerPanel.loadInterrupted',
                  'Folder load interrupted'
                )
              }
            : state
        ])
      )
    )
    void loadDirectory('').then((result) => {
      // Legacy roots replace their entire synthesized cache; only readDir roots need child reads.
      if (!cancelled && result === 'directory') {
        refreshExpandedDirectories()
      }
    })
    return () => {
      cancelled = true
    }
  }, [scope, loadDirectory])

  useEffect(() => {
    if (connState !== 'connected' || pendingDirectoryRetriesRef.current.size === 0) {
      return
    }
    const pending = [...pendingDirectoryRetriesRef.current]
    pendingDirectoryRetriesRef.current.clear()
    for (const relativePath of pending) {
      void loadDirectory(relativePath)
    }
  }, [connState, loadDirectory])

  const rows = useMemo(
    () => flattenDirectoryCache(directoryCache, expanded),
    [directoryCache, expanded]
  )

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(relativePath)) {
          next.delete(relativePath)
        } else {
          next.add(relativePath)
        }
        return next
      })
      const state = getDirectoryCacheState(directoryCache, relativePath)
      if (!expanded.has(relativePath) && !state?.loading && (!state?.entries || state.error)) {
        void loadDirectory(relativePath)
      }
    },
    [directoryCache, expanded, loadDirectory]
  )

  const retryDirectory = useCallback(
    (relativePath: string) => {
      if (connState !== 'connected' && hostId) {
        // The page cannot re-dial, but its queued read runs when the shell reconnects.
        pendingDirectoryRetriesRef.current.add(relativePath)
        void forceReconnect?.(hostId)
        return
      }
      void loadDirectory(relativePath)
    },
    [connState, forceReconnect, hostId, loadDirectory]
  )

  const previewFile = useCallback(
    (relativePath: string, displayName: string) => {
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

  const renderItem: ListRenderItem<FileExplorerRow> = ({ item }) => {
    return (
      <MobileFileExplorerRow
        item={item}
        maximumIndentation={Math.max(0, panelWidth / 3 - spacing.lg)}
        expanded={expanded}
        onPreviewFile={previewFile}
        onRetryDirectory={retryDirectory}
        onToggleDirectory={toggleDirectory}
      />
    )
  }

  const headerBar = (
    <View style={styles.topBar}>
      {embedded ? (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => onRequestClose?.()}
          hitSlop={8}
          accessibilityLabel={t('files.fileExplorerPanel.closeFiles', 'Close files')}
        >
          <X size={20} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('files.fileExplorerPanel.backToSession', 'Back to session')}
        >
          <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      )}
      <View style={styles.titleBlock}>
        <Text style={styles.title} numberOfLines={1}>
          {t('files.fileExplorerPanel.title', 'Files')}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {legacyListTruncated
            ? t('files.fileExplorerPanel.truncatedList', '{{worktreeLabel}} - Showing first 5000', {
                worktreeLabel
              })
            : worktreeLabel}
        </Text>
      </View>
    </View>
  )

  // Revive the parked transport while disconnected (#5049); the connected effect retries loadDirectory.
  const rootRetry = connectionRetryAction({
    hostId,
    needsReconnect: connState !== 'connected',
    forceReconnect,
    reload: () => void loadDirectory('')
  })
  const body = loading ? (
    <View style={styles.state}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : error ? (
    <MobileLoadErrorState message={error} onRetry={rootRetry} />
  ) : rows.length === 0 ? (
    <View style={styles.state}>
      <Text style={styles.emptyText}>
        {t('files.fileExplorerPanel.emptyState', 'No files found')}
      </Text>
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

  // The embedded dock owns insets and layout; only the full-screen variant needs SafeAreaView and header chrome.
  return (
    <View
      style={styles.container}
      onLayout={({ nativeEvent }) => setPanelWidth(nativeEvent.layout.width)}
    >
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
