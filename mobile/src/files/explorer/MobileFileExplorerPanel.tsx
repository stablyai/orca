import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction
} from 'react'
import { FlatList, View, type ListRenderItem } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft, FolderOpen, X } from 'lucide-react-native'
import {
  partialMatchKey,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryResult
} from '@tanstack/react-query'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { useWorkspaceRouteHandoff } from '../../navigation/workspace-route-handoff'
import { useHostQueries, useHostQuery } from '../../query/host-query'
import { hostQueryKey, hostScopeKey } from '../../query/host-query-key'
import { hostScreenState } from '../../query/host-query-screen-state'
import { useForceReconnect } from '../../transport/connection/host-client-hooks'
import { useWorkspaceClient } from '../../worktree/execution-hosts/use-workspace-client'
import { connectionRetryAction } from '../../transport/connection/connection-retry-action'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { getWorktreeLabel } from '../../worktree/row-presentation/worktree-label'
import type { DirectoryCache, DirectoryState, FileExplorerRow } from './file-tree'
import { spacing } from '../../theme/mobile-theme'
import { fileDirectoryQuery, type DirectoryRead } from './mobile-file-explorer-operations'
import { fileExplorerStylesSheet } from './mobile-file-explorer-styles'
import { useMobileFileExplorerRows } from './mobile-file-explorer-rows'
import { MobileFileExplorerRow } from './mobile-file-explorer-row'
import { useMobileFileExplorerRowActions } from './mobile-file-explorer-row-actions-sheet'
import { useMobileFileExplorerPaging } from './use-mobile-file-explorer-paging'
import { useMobileFileExplorerDecorations } from './use-mobile-file-explorer-decorations'
import { useMobileNativeChatFileSearch } from '../../session/native-chat/composer/attachments/use-mobile-native-chat-file-search'
import { useRefreshHint } from '../../query/refresh-hint'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { MOBILE_FILE_CONTENT_SEARCH_RUNTIME_CAPABILITY } from '../../../../src/shared/file-search/mobile-file-content-search'
import { navigateToMobileFilePreview } from '../preview/mobile-file-preview-navigation'
import {
  MobileLoadErrorState,
  MobileNoMatchState,
  MobileOfflineState,
  MobileStateView
} from '../../components/feedback/MobileStateView'
import { BottomSearchBar } from '../../components/nav-bar/BottomSearchBar'
import { NavBar } from '../../components/nav-bar/NavBar'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import type { Translate } from '../../i18n/mobile-i18n'
import { recomputeOn } from '../../hooks/recompute-on'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useThemedStyles } from '../../theme/themed-styles'

const ROOT = { relativePath: '' }
// The most the host's search returns, best first.
const SEARCH_RESULT_LIMIT = 32
// As long as the host keeps its own file list, so files an agent just made turn up.
const SEARCH_MAX_AGE_MS = 30_000
const NO_FOLDERS: ReadonlySet<string> = new Set()

type FolderRead = Pick<UseQueryResult<DirectoryRead>, 'data' | 'error' | 'isFetching'>

// Stable, so useQueries memoizes the folder reads; a loaded folder's background refetch changes nothing here.
function pickFolderReads(results: UseQueryResult<DirectoryRead>[]): FolderRead[] {
  return results.map(({ data, error, isFetching }) =>
    data === undefined ? { data, error, isFetching } : { data, error: null, isFetching: false }
  )
}

// Open folders whose parents are all open: only these are on screen, so only these refetch on reconnect.
function shownFolders(expanded: ReadonlySet<string>): { relativePath: string }[] {
  return [...expanded]
    .filter((path) => {
      const segments = path.split('/')
      return segments.every(
        (_, index) => index === 0 || expanded.has(segments.slice(0, index).join('/'))
      )
    })
    .map((relativePath) => ({ relativePath }))
}

function folderPathOf(key: QueryKey): string | undefined {
  const params: unknown = key[4]
  return typeof params === 'object' &&
    params !== null &&
    'relativePath' in params &&
    typeof params.relativePath === 'string'
    ? params.relativePath
    : undefined
}

function directoryState(read: Extract<DirectoryRead, { kind: 'directory' }>): DirectoryState {
  return { entries: read.entries, total: read.total, hasMore: read.hasMore }
}

// Counts listings landing under `prefix` (keep it stable), observed or not: a folder closed before its read (or a
// later page) finished still feeds the filter.
function useListingsVersion(queryClient: QueryClient, prefix: QueryKey): number {
  const version = useRef(0)
  const subscribe = useCallback(
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type === 'updated' &&
          event.action.type === 'success' &&
          partialMatchKey(event.query.queryKey, prefix)
        ) {
          version.current += 1
          notify()
        }
      }),
    [prefix, queryClient]
  )
  return useSyncExternalStore(subscribe, () => version.current)
}

// A folder keeps its last rows while it refreshes or fails; only an empty one shows loading or why it is empty.
function folderState(read: FolderRead, connState: ConnectionState, t: Translate): DirectoryState {
  switch (hostScreenState(read, connState)) {
    case 'data':
      return read.data?.kind === 'directory' ? directoryState(read.data) : { entries: [] }
    case 'empty-loading':
      return { entries: [], loading: true }
    case 'empty-error':
      return {
        entries: [],
        error:
          read.error?.message || t('files.fileExplorerPanel.loadFailed', 'Unable to load files')
      }
    case 'empty-connecting':
    case 'empty-offline':
      return {
        entries: [],
        error:
          connState === 'connected'
            ? t('common.connectingToHost', 'Connecting to host…')
            : t('common.waitingForHost', 'Waiting for host…')
      }
  }
}

export function MobileFileExplorerPanel(props: {
  hostId: string
  worktreeId: string
  name?: string
  embedded?: boolean
  /** Inside a panel that names it already (a bot's Files tab): no bar of its own. */
  headerless?: boolean
  onRequestClose?: () => void
}) {
  const styles = useThemedStyles(fileExplorerStylesSheet)
  const t = useMobileTranslation()
  const { hostId, worktreeId, name, embedded, headerless, onRequestClose } = props
  const router = useWorkspaceRouteHandoff()
  const executionHost = useWorkspaceExecutionHost()
  const { client, state: connState } = useWorkspaceClient(hostId)
  const forceReconnect = useForceReconnect()
  const queryClient = useQueryClient()
  const scope = JSON.stringify([hostId, executionHost, worktreeId])
  const exec = executionHost ?? 'local'
  const target = useMemo(() => ({ exec, worktree: worktreeId }), [exec, worktreeId])
  // Held with the scope it was opened in, so another worktree starts collapsed without an effect.
  const [scopedExpanded, setScopedExpanded] = useState({ scope, paths: new Set<string>() })
  const expanded = scopedExpanded.scope === scope ? scopedExpanded.paths : NO_FOLDERS
  const setExpanded = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    (action) =>
      setScopedExpanded((previous) => {
        const current = previous.scope === scope ? previous.paths : new Set<string>()
        return { scope, paths: typeof action === 'function' ? action(current) : action }
      }),
    [scope]
  )
  const [panelWidth, setPanelWidth] = useState(0)
  const [filterBarHeight, setFilterBarHeight] = useState(0)
  const { openRowActions, rowActionsSheet } = useMobileFileExplorerRowActions()
  const insets = useSafeAreaInsets()
  const worktreeLabel = getWorktreeLabel(name, worktreeId, t)

  const host = { hostId, client }
  const rootQuery = useHostQuery(fileDirectoryQuery, host, target, ROOT)
  const rootRead = rootQuery.data
  // A legacy root already holds every folder.
  const folders = useMemo(
    () => (rootRead?.kind === 'directory' ? shownFolders(expanded) : []),
    [expanded, rootRead?.kind]
  )
  const folderReads = useHostQueries(fileDirectoryQuery, host, target, folders, pickFolderReads)

  const refreshDirectory = useCallback(
    (relativePath: string) =>
      queryClient.refetchQueries({
        queryKey: hostQueryKey(hostId, fileDirectoryQuery.family, target, { relativePath }),
        exact: true
      }),
    [hostId, queryClient, target]
  )

  const { folderPaging, showMore } = useMobileFileExplorerPaging({
    scope,
    hostId,
    client,
    target
  })
  const listingsKey = useMemo(
    () => [...hostScopeKey(hostId), fileDirectoryQuery.family, target],
    [hostId, target]
  )
  const listingsVersion = useListingsVersion(queryClient, listingsKey)

  const directoryCache = useMemo(
    () =>
      recomputeOn([listingsVersion], (): DirectoryCache => {
        if (rootRead?.kind === 'legacy') {
          return rootRead.cache
        }
        // Closed folders and earlier visits stay in the cache, so reopening one shows its rows at once.
        const cached = queryClient.getQueriesData<DirectoryRead>({ queryKey: listingsKey })
        // fromEntries keeps a folder named __proto__ an own key; assignment would set the prototype.
        return Object.fromEntries([
          ...cached.flatMap(([key, data]): [string, DirectoryState][] => {
            const relativePath = folderPathOf(key)
            return relativePath !== undefined && data?.kind === 'directory'
              ? [[relativePath, directoryState(data)]]
              : []
          }),
          ...folders.map(({ relativePath }, index): [string, DirectoryState] => [
            relativePath,
            folderState(folderReads[index], connState, t)
          ])
        ])
      }),
    // listingsVersion marks cache writes that getQueriesData reads but nothing here observes.
    [connState, folderReads, folders, listingsKey, listingsVersion, queryClient, rootRead, t]
  )

  const search = useMobileNativeChatFileSearch({
    // An older host's root read already holds its whole file list, which the listed matches search.
    client: rootRead?.kind === 'legacy' ? null : client,
    worktreeId,
    limit: SEARCH_RESULT_LIMIT,
    maxAgeMs: SEARCH_MAX_AGE_MS
  })
  const searchesContents = useRouteCapability(MOBILE_FILE_CONTENT_SEARCH_RUNTIME_CAPABILITY)
  const { filter, setFilter, filtering, rows, searchPending, contentPending, onToggleDirectory } =
    useMobileFileExplorerRows({
      scope,
      directoryCache,
      expanded,
      setExpanded,
      loadDirectory: refreshDirectory,
      search,
      contentSearch: searchesContents ? { client, worktreeId } : null,
      connected: connState === 'connected'
    })
  const refreshing = useRefreshHint(searchPending || contentPending)
  const decorate = useMobileFileExplorerDecorations({
    host,
    target,
    enabled: rootRead?.kind === 'directory',
    directoryCache,
    rows
  })

  const retryDirectory = useCallback(
    (relativePath: string) => {
      if (connState !== 'connected' && hostId) {
        // The page cannot re-dial; the connected edge refetches every folder on screen.
        void forceReconnect?.(hostId)
        return
      }
      void refreshDirectory(relativePath)
    },
    [connState, forceReconnect, hostId, refreshDirectory]
  )

  const previewFile = useCallback(
    (relativePath: string, displayName: string, at?: { line: number; column: number }) => {
      navigateToMobileFilePreview(
        router,
        {
          hostId,
          worktreeId,
          relativePath,
          name: displayName,
          worktreeName: name,
          ...(at ? { line: String(at.line), column: String(at.column) } : {})
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
        decorate={decorate}
        onPreviewFile={previewFile}
        onRetryDirectory={retryDirectory}
        onToggleDirectory={onToggleDirectory}
        onOpenActions={openRowActions}
        folderPaging={folderPaging}
        onShowMore={showMore}
      />
    )
  }

  const headerBar = (
    <NavBar
      leading={
        embedded ? (
          <NavBarButton
            icon={X}
            onPress={() => onRequestClose?.()}
            accessibilityLabel={t('files.fileExplorerPanel.closeFiles', 'Close files')}
          />
        ) : (
          <NavBarButton
            icon={ChevronLeft}
            onPress={() => router.back()}
            accessibilityLabel={t('files.fileExplorerPanel.backToSession', 'Back to session')}
          />
        )
      }
      title={t('files.fileExplorerPanel.title', 'Files')}
      refreshing={refreshing}
      subtitle={
        rootRead?.kind === 'legacy' && rootRead.truncated
          ? t('files.fileExplorerPanel.truncatedList', '{{worktreeLabel}} - Showing first 5000', {
              worktreeLabel
            })
          : worktreeLabel
      }
    />
  )

  // Revive the parked transport while disconnected (#5049); the connected edge then refetches the root.
  const rootRetry = connectionRetryAction({
    hostId,
    needsReconnect: connState !== 'connected',
    forceReconnect,
    reload: () => void rootQuery.refetch()
  })
  // Cached rows paint before the client attaches.
  const rootScreen =
    client || rootRead
      ? hostScreenState(
          { data: rootRead, error: rootQuery.error, isFetching: rootQuery.isFetching },
          connState
        )
      : 'empty-connecting'
  const treeReady = rootScreen === 'data' && (rows.length > 0 || filtering)
  const body =
    rootScreen !== 'data' && connState !== 'connected' ? (
      <MobileOfflineState onReconnect={rootRetry} />
    ) : rootScreen === 'empty-error' ? (
      <MobileLoadErrorState
        error={
          rootQuery.error?.message ||
          t('files.fileExplorerPanel.loadFailed', 'Unable to load files')
        }
        onRetry={rootRetry}
      />
    ) : rootScreen !== 'data' ? (
      <MobileStateView loading title={t('files.fileExplorerPanel.loading', 'Loading files…')} />
    ) : rows.length === 0 && filtering && (searchPending || contentPending) ? (
      <MobileStateView loading title={t('files.fileExplorerPanel.searching', 'Searching…')} />
    ) : rows.length === 0 && filtering ? (
      <MobileNoMatchState onClear={() => setFilter('')} bottomInset={filterBarHeight} />
    ) : rows.length === 0 ? (
      <MobileStateView
        icon={FolderOpen}
        title={t('files.fileExplorerPanel.emptyState', 'No files found')}
      />
    ) : (
      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        extraData={[folderPaging, decorate]}
        contentContainerStyle={[
          styles.listContent,
          treeReady && { paddingBottom: spacing.sm + filterBarHeight }
        ]}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
    )

  // The embedded dock owns insets and layout; only the full-screen variant needs SafeAreaView and header chrome.
  return (
    <View
      style={[styles.container, headerless && styles.onSheet]}
      onLayout={({ nativeEvent }) => setPanelWidth(nativeEvent.layout.width)}
    >
      {headerless ? null : embedded ? (
        <View style={styles.header}>{headerBar}</View>
      ) : (
        <SafeAreaView style={styles.header} edges={['top']}>
          {headerBar}
        </SafeAreaView>
      )}
      {body}
      {treeReady ? (
        <BottomSearchBar
          value={filter}
          onChangeText={setFilter}
          placeholder={t('files.fileExplorerPanel.searchPlaceholder', 'Search files')}
          bottomInset={insets.bottom}
          onCoveredHeightChange={setFilterBarHeight}
        />
      ) : null}
      {rowActionsSheet}
    </View>
  )
}
