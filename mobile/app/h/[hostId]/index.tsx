import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  ActivityIndicator,
  Alert,
  RefreshControl
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import {
  Search,
  X,
  Pin,
  List,
  SlidersHorizontal,
  Layers,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Plus,
  Moon,
  Filter,
  Check,
  UserCircle,
  PanelLeftClose,
  SquareTerminal
} from 'lucide-react-native'
import type { RpcClient } from '../../../src/transport/rpc-client'
import { loadHosts, updateLastConnected } from '../../../src/transport/host-store'
import { removeHostAndCloseClient } from '../../../src/transport/host-removal-lifecycle'
import {
  useHostClient,
  useCloseHost,
  useForceReconnect
} from '../../../src/transport/client-context'
import { useWorktreeResync } from '../../../src/transport/use-worktree-resync'
import {
  useLastConnectedAt,
  useReconnectAttempt
} from '../../../src/transport/client-context-connection-metrics'
import {
  classifyConnection,
  type ConnectionVerdict
} from '../../../src/transport/connection-health'
import type { RpcSuccess } from '../../../src/transport/types'
import { StatusDot } from '../../../src/components/StatusDot'
import { NewWorktreeModalController } from '../../../src/components/NewWorktreeModalController'
import { NewWorkspaceFab, FAB_SIZE } from '../../../src/components/NewWorkspaceFab'
import { MobileRepoIcon } from '../../../src/components/MobileRepoIcon'
import { WorktreeListRow } from '../../../src/components/WorktreeListRow'
import { useNow } from '../../../src/hooks/use-now'
import { useActiveWorktreeScroll } from '../../../src/hooks/use-active-worktree-scroll'
import type { RepoIcon } from '../../../../src/shared/repo-icon'
import { PickerModal } from '../../../src/components/PickerModal'
import { ActionSheetContent } from '../../../src/components/ActionSheetModal'
import { buildWorktreeNavigationActions } from '../../../src/agent-history/worktree-navigation-actions'
import { floatingWorkspaceSessionPath } from '../../../src/session/floating-workspace'
import { ConfirmModal } from '../../../src/components/ConfirmModal'
import { BottomDrawer } from '../../../src/components/BottomDrawer'
import { ProtocolBlockScreen } from '../../../src/components/ProtocolBlockScreen'
import { AuthFailedBanner } from '../../../src/components/AuthFailedBanner'
import { MobileSearchField } from '../../../src/components/MobileSearchField'
import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { getCachedWorktrees, setCachedWorktrees } from '../../../src/cache/worktree-cache'
import { setCachedRepos } from '../../../src/cache/repo-cache'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'
import { leaveHostRoute } from '../../../src/host-route-exit'
import { useHostStatusGates } from '../../../src/transport/host-status-gates'
import { loadPinnedIds, savePinnedIds } from '../../../src/storage/preferences'
import {
  createInitialHostRouteActionState,
  resolveHostRouteActionState,
  setHostRouteNewWorktreeVisible
} from '../../../src/host-route-action-state'
import {
  applyDesktopViewSettings,
  groupModeToDesktop,
  type MobileGroupMode,
  type MobileSortMode,
  type MobileViewState,
  type WorkspaceViewSettings
} from '../../../src/worktree/workspace-view-settings'
import {
  getWorktreeStatus,
  isWorktreePinned,
  type FilterState,
  type Worktree
} from '../../../src/worktree/workspace-list-sections'
import { useWorkspaceSections } from '../../../src/worktree/use-workspace-sections'
import { getMobileWorkspaceLineageGroupKey } from '../../../src/worktree/mobile-workspace-lineage'
import { areWorktreeListsEqual } from '../../../src/worktree/worktree-list-snapshot'
import { repoColor } from '../../../src/worktree/repo-color'
import {
  WORKSPACE_GROUP_OPTIONS as GROUP_OPTIONS,
  WORKSPACE_SORT_OPTIONS as SORT_OPTIONS
} from '../../../src/worktree/workspace-list-picker-options'
import type { RepoSummary } from '../../../src/worktree/host-worktree-rpc-types'
import type { WorkspaceStatusDefinition } from '../../../../src/shared/types'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from '../../../src/worktree/mobile-workspace-statuses'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return v.kind === 'warning' || v.kind === 'unreachable' || v.kind === 'auth-failed'
}

const REPO_METADATA_REFRESH_MS = 60_000

type HostScreenProps = {
  // When true, rendered as the persistent tablet sidebar by the host layout, not as its own routed screen.
  embedded?: boolean
  // Route params aren't in scope when rendered from the layout, so the caller passes these explicitly.
  hostId?: string
  action?: string
  onHideSidebar?: () => void
}

export function HostScreen({
  embedded = false,
  hostId: hostIdProp,
  action: actionProp,
  onHideSidebar
}: HostScreenProps = {}) {
  const params = useLocalSearchParams<{ hostId: string; action?: string }>()
  const hostId = hostIdProp ?? params.hostId
  const action = actionProp ?? params.action
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  // Why: cap and center the list on wide/tablet canvases; on phones isWideLayout is false so it stays edge-to-edge.
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const [initialCache] = useState(() =>
    hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
  )
  // Shared client per host owned by RpcClientProvider. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const reconnectAttempts = useReconnectAttempt(hostId)
  const lastConnectedAt = useLastConnectedAt(hostId)
  const clientRef = useRef<RpcClient | null>(null)
  const fetchWorktreesInFlightRef = useRef(false)
  const fetchRepoMetadataInFlightRef = useRef(false)
  const repoMetadataFetchedAtRef = useRef(0)
  const newWorktreeModalRef = useRef<{ open: () => void }>(null)
  const newWorktreeModalVisibleRef = useRef(false)
  const closeHostClient = useCloseHost()
  const forceReconnectHost = useForceReconnect()
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [worktreesLoaded, setWorktreesLoaded] = useState(initialCache != null)
  // Why: track the locally-opened worktree so the active-row highlight moves instantly instead of waiting for the next poll.
  const [optimisticActiveWorktreeId, setOptimisticActiveWorktreeId] = useState<string | null>(null)
  // One tick drives every visible agent row's relative timestamp.
  const now = useNow(30_000)
  const [repoColorsByName, setRepoColorsByName] = useState<Map<string, string>>(new Map())
  const [repoIconsByName, setRepoIconsByName] = useState<Map<string, RepoIcon>>(new Map())
  const [hostName, setHostName] = useState('')
  const [error, setError] = useState('')
  const [lastKnownWorktrees, setLastKnownWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [sortMode, setSortMode] = useState<MobileSortMode>('recent')
  const [filters, setFilters] = useState<FilterState>({
    filterRepoIds: new Set(),
    hideSleeping: false,
    hideDefaultBranch: false
  })
  const [groupMode, setGroupMode] = useState<MobileGroupMode>('repo')
  const [workspaceStatuses, setWorkspaceStatuses] = useState<readonly WorkspaceStatusDefinition[]>(
    DEFAULT_MOBILE_WORKSPACE_STATUSES
  )
  // displayName → repo id: filters key on repo id, but section headers/rows key on displayName, so bridge the two.
  const [repoIdsByName, setRepoIdsByName] = useState<Map<string, string>>(new Map())
  const [showSortPicker, setShowSortPicker] = useState(false)
  const [showGroupPicker, setShowGroupPicker] = useState(false)
  const [showFilterModal, setShowFilterModal] = useState(false)
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const { hostCapabilities, floatingWorkspaceEnabled, compatVerdict } = useHostStatusGates({
    hostId,
    client,
    connState
  })
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [confirmRemoveHost, setConfirmRemoveHost] = useState(false)
  const [routeActionState, setRouteActionState] = useState(() =>
    createInitialHostRouteActionState(action)
  )
  const [sleptIds, setSleptIds] = useState<Set<string>>(new Set())

  const leaveHost = useCallback(() => {
    leaveHostRoute(router)
  }, [router])
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // Why: ref so the ui.get merge and ui.set writes read the latest values without re-creating callbacks on every state change.
  const viewStateRef = useRef<MobileViewState>({
    groupMode: 'repo',
    sortMode: 'recent',
    hideSleeping: false,
    hideDefaultBranch: false,
    filterRepoIds: [],
    collapsedGroups: [],
    workspaceStatuses: DEFAULT_MOBILE_WORKSPACE_STATUSES
  })

  useEffect(() => {
    viewStateRef.current = {
      groupMode,
      sortMode,
      hideSleeping: filters.hideSleeping,
      hideDefaultBranch: filters.hideDefaultBranch,
      filterRepoIds: [...filters.filterRepoIds],
      collapsedGroups: [...collapsedGroups],
      workspaceStatuses
    }
  }, [groupMode, sortMode, filters, collapsedGroups, workspaceStatuses])

  // Apply a MobileViewState onto the individual states and the snapshot ref in one shot.
  const applyViewState = useCallback((next: MobileViewState) => {
    viewStateRef.current = next
    setGroupMode(next.groupMode)
    setSortMode(next.sortMode)
    setWorkspaceStatuses(next.workspaceStatuses)
    setCollapsedGroups(new Set(next.collapsedGroups))
    setFilters({
      filterRepoIds: new Set(next.filterRepoIds),
      hideSleeping: next.hideSleeping,
      hideDefaultBranch: next.hideDefaultBranch
    })
  }, [])

  // Apply the change locally, then push full settings to the desktop's shared store (ui.set) so both apps stay in sync.
  const persistViewSettings = useCallback(
    (patch: Partial<MobileViewState>) => {
      const next: MobileViewState = { ...viewStateRef.current, ...patch }
      applyViewState(next)
      if (!client) {
        return
      }
      const payload: WorkspaceViewSettings = {
        groupBy: groupModeToDesktop(next.groupMode),
        sortBy: next.sortMode,
        hideSleepingWorkspaces: next.hideSleeping,
        hideDefaultBranchWorkspace: next.hideDefaultBranch,
        filterRepoIds: next.filterRepoIds,
        collapsedGroups: next.collapsedGroups
      }
      void client.sendRequest('ui.set', payload).catch(() => {
        // Best-effort: view settings are a convenience preference.
      })
    },
    [client, applyViewState]
  )

  const openNewWorktreeModal = useCallback(() => {
    const modal = newWorktreeModalRef.current
    if (!modal) {
      return
    }
    newWorktreeModalVisibleRef.current = true
    modal.open()
  }, [])

  const resolvedRouteActionState = resolveHostRouteActionState(routeActionState, action)
  // Why: resolve `action=newWorktree` before commit, but don't reopen after the user closes while the URL persists.
  if (resolvedRouteActionState !== routeActionState) {
    setRouteActionState(resolvedRouteActionState)
  }
  const showNewWorktree = resolvedRouteActionState.showNewWorktree
  const setShowNewWorktreeVisible = useCallback((visible: boolean) => {
    setRouteActionState((current) => setHostRouteNewWorktreeVisible(current, visible))
  }, [])

  // Load persisted pins from local cache; view settings are no longer local (they sync via ui.get).
  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void (async () => {
      const pins = await loadPinnedIds(hostId)
      if (stale) {
        return
      }
      setPinnedIds(pins)
    })()
    return () => {
      stale = true
    }
  }, [hostId])

  // Merge the desktop's shared view settings (PersistedUIState) onto local state so desktop changes appear here.
  const syncViewSettingsFromDesktop = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    const requestClient = client
    const requestHostId = hostId
    try {
      const response = await requestClient.sendRequest('ui.get')
      if (clientRef.current !== requestClient || hostId !== requestHostId || !response.ok) {
        return
      }
      const ui = ((response as RpcSuccess).result as { ui?: WorkspaceViewSettings }).ui
      if (!ui) {
        return
      }
      applyViewState(applyDesktopViewSettings(viewStateRef.current, ui))
    } catch {
      // Transient transport failure; retry on the next focus/connect.
    }
  }, [client, connState, hostId, applyViewState])

  // Why: mirror client into a ref so imperative call sites read it without re-subscribing.
  useEffect(() => {
    clientRef.current = client
  }, [client])

  useEffect(() => {
    setHostName('')
    setError('')
    setRepoColorsByName(new Map())
    setRepoIconsByName(new Map())
    repoMetadataFetchedAtRef.current = 0
    // Why: useState initializer runs only on first mount, so re-seed the cache when Expo Router reuses this screen for a new hostId.
    const freshCache = hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
    if (freshCache) {
      setWorktrees(freshCache)
      setLastKnownWorktrees(freshCache)
      setWorktreesLoaded(true)
    } else {
      setWorktreesLoaded(false)
      setWorktrees([])
      setLastKnownWorktrees([])
    }
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }
      setHostName(host.name)
      void updateLastConnected(host.id)
    })
    return () => {
      stale = true
    }
  }, [hostId])

  const fetchRepoMetadata = useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId) {
        return
      }
      if (fetchRepoMetadataInFlightRef.current) {
        return
      }
      const now = Date.now()
      if (!options.force && now - repoMetadataFetchedAtRef.current < REPO_METADATA_REFRESH_MS) {
        return
      }
      fetchRepoMetadataInFlightRef.current = true
      const requestClient = client,
        requestHostId = hostId
      try {
        const repoResponse = await requestClient.sendRequest('repo.list')
        if (clientRef.current !== requestClient || hostId !== requestHostId || !repoResponse.ok) {
          return
        }
        const repoResult = (repoResponse as RpcSuccess).result as { repos: RepoSummary[] }
        repoMetadataFetchedAtRef.current = Date.now()
        setCachedRepos(requestHostId, repoResult.repos)
        setRepoColorsByName(
          new Map(
            repoResult.repos.map((repo) => [
              repo.displayName,
              repo.badgeColor || repoColor(repo.displayName)
            ])
          )
        )
        setRepoIconsByName(
          new Map(
            repoResult.repos.flatMap((repo) =>
              repo.repoIcon ? [[repo.displayName, repo.repoIcon] as const] : []
            )
          )
        )
        setRepoIdsByName(new Map(repoResult.repos.map((repo) => [repo.displayName, repo.id])))
      } catch {
        // Repo metadata is decorative; the next throttled refresh can retry.
      } finally {
        fetchRepoMetadataInFlightRef.current = false
      }
    },
    [client, connState, hostId]
  )

  const fetchWorktrees = useCallback(
    async (options: { allowDuringModal?: boolean } = {}) => {
      if (!client || connState !== 'connected') {
        return
      }
      if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
        return
      }
      // Why: prevent slow remote hosts from stacking overlapping worktree.ps requests during polling.
      if (fetchWorktreesInFlightRef.current) {
        return
      }
      fetchWorktreesInFlightRef.current = true
      const requestClient = client
      const requestHostId = hostId

      try {
        // Why: worktree.ps silently truncates at 200; use a high cap so large hosts don't drop workspaces.
        const response = await requestClient.sendRequest('worktree.ps', { limit: 10000 })
        if (clientRef.current !== requestClient || hostId !== requestHostId) {
          return
        }
        if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
          return
        }
        if (response.ok) {
          const result = (response as RpcSuccess).result as { worktrees: Worktree[] }
          // Why: reuse the existing array on identical snapshots to keep SectionList/sort rebuilds off the tap path.
          setWorktrees((current) =>
            areWorktreeListsEqual(current, result.worktrees) ? current : result.worktrees
          )
          setLastKnownWorktrees((current) =>
            areWorktreeListsEqual(current, result.worktrees) ? current : result.worktrees
          )
          setWorktreesLoaded(true)
          // Why (#8498): overwrite the home-written cache with the confirmed snapshot so a reconnect/remount can't serve a stale list.
          if (hostId) {
            setCachedWorktrees(hostId, result.worktrees)
          }
          // Drop the optimistic active override once the host reports it active, so later desktop changes win.
          setOptimisticActiveWorktreeId((pending) =>
            pending && result.worktrees.some((w) => w.worktreeId === pending && w.isActive)
              ? null
              : pending
          )

          // Clear optimistic sleep overrides once the server confirms inactive (liveTerminalCount === 0).
          setSleptIds((prev) => {
            if (prev.size === 0) {
              return prev
            }
            const still = new Set<string>()
            for (const id of prev) {
              const wt = result.worktrees.find((w) => w.worktreeId === id)
              if (wt && wt.liveTerminalCount > 0) {
                still.add(id)
              }
            }
            return still.size === prev.size ? prev : still
          })

          // Sync pin state from server so desktop-initiated pins reflect without relying on stale AsyncStorage.
          const serverPinned = new Set(
            result.worktrees.filter((w) => w.isPinned).map((w) => w.worktreeId)
          )
          setPinnedIds((prev) => {
            if (serverPinned.size === prev.size && [...serverPinned].every((id) => prev.has(id))) {
              return prev
            }
            if (hostId) {
              void savePinnedIds(hostId, serverPinned)
            }
            return serverPinned
          })
        }
      } catch {
        // Will retry on reconnect
      } finally {
        fetchWorktreesInFlightRef.current = false
      }
    },
    [client, connState, hostId]
  )

  useFocusEffect(
    useCallback(() => {
      // Why: focus nudges reconnect and probes a possibly half-open socket; empty deps fire per focus, not per state flip (which defeats backoff).
      clientRef.current?.notifyForeground()
    }, [])
  )

  useFocusEffect(
    useCallback(() => {
      // The embedded sidebar isn't a routed screen (focus never fires); it polls via the mount effect below.
      if (embedded || connState !== 'connected') {
        return
      }
      void fetchWorktrees()
      void fetchRepoMetadata()
      // Pull desktop's shared view settings on focus so desktop changes show up without a manual refresh.
      void syncViewSettingsFromDesktop()
      // Why: React Navigation keeps prior screens mounted; only poll while this route is visible.
      const interval = setInterval(() => {
        void fetchWorktrees()
        void fetchRepoMetadata()
      }, 3000)
      return () => clearInterval(interval)
    }, [embedded, connState, fetchWorktrees, fetchRepoMetadata, syncViewSettingsFromDesktop])
  )

  // Why: the embedded sidebar is never the focused route, so useFocusEffect never polls; mirror it from a mount effect.
  useEffect(() => {
    if (!embedded || connState !== 'connected') {
      return
    }
    void fetchWorktrees()
    void fetchRepoMetadata()
    void syncViewSettingsFromDesktop()
    const interval = setInterval(() => {
      void fetchWorktrees()
      void fetchRepoMetadata()
    }, 3000)
    return () => clearInterval(interval)
  }, [embedded, connState, fetchWorktrees, fetchRepoMetadata, syncViewSettingsFromDesktop])

  // Why (#8498): steady-state polls miss the transition INTO 'connected' after background/sleep, when the cache is stalest.
  const { refreshing, onRefresh } = useWorktreeResync({
    client,
    connState,
    fetchWorktrees,
    fetchRepoMetadata
  })

  const updateLocalPins = useCallback(
    (worktreeId: string, pinned: boolean) => {
      setPinnedIds((prev) => {
        const next = new Set(prev)
        if (pinned) {
          next.add(worktreeId)
        } else {
          next.delete(worktreeId)
        }
        if (hostId) {
          void savePinnedIds(hostId, next)
        }
        return next
      })
    },
    [hostId]
  )

  const togglePin = useCallback(
    (worktreeId: string) => {
      const worktree = worktrees.find((w) => w.worktreeId === worktreeId)
      const currentlyPinned = worktree
        ? isWorktreePinned(worktree, pinnedIds)
        : pinnedIds.has(worktreeId)
      const newPinned = !currentlyPinned

      setWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )
      setLastKnownWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )

      updateLocalPins(worktreeId, newPinned)

      if (client) {
        client
          .sendRequest('worktree.set', {
            worktree: `id:${worktreeId}`,
            isPinned: newPinned
          })
          .catch(() => {})
      }
    },
    [client, worktrees, pinnedIds, updateLocalPins]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      if (!client) {
        return
      }

      const removeFromList = (list: Worktree[]) =>
        list.filter((w) => w.worktreeId !== item.worktreeId)
      setWorktrees(removeFromList)
      setLastKnownWorktrees(removeFromList)

      try {
        const response = await client.sendRequest('worktree.rm', {
          worktree: `id:${item.worktreeId}`,
          force: true
        })
        if (!response.ok) {
          setWorktrees((prev) => [...prev, item])
          setLastKnownWorktrees((prev) => [...prev, item])
        }
        void fetchWorktrees()
      } catch {
        setWorktrees((prev) => [...prev, item])
        setLastKnownWorktrees((prev) => [...prev, item])
      }
    },
    [client, fetchWorktrees]
  )

  const handleRemoveHost = useCallback(async () => {
    if (!hostId) {
      return
    }
    try {
      await removeHostAndCloseClient(hostId, closeHostClient)
      leaveHost()
    } catch {
      // Why: removal can fail while still paired; re-open confirm (ConfirmModal closes on confirm).
      setConfirmRemoveHost(true)
      Alert.alert('Could not remove host', 'Please try again.')
    }
  }, [hostId, leaveHost, closeHostClient])

  const navigateFromHostList = useCallback(
    (target: string) => {
      if (!embedded) {
        router.push(target)
        return
      }
      if (pathname === (target.split('?')[0] ?? target)) {
        return
      }
      if (pathname === `/h/${hostId}`) {
        router.push(target)
        return
      }
      router.replace(target)
    },
    [embedded, hostId, pathname, router]
  )

  const openWorktreeSession = useCallback(
    (item: Worktree) => {
      setOptimisticActiveWorktreeId(item.worktreeId)
      if (client && connState === 'connected') {
        void client
          .sendRequest('worktree.activate', {
            worktree: `id:${item.worktreeId}`,
            notifyClients: false,
            navigation: 'caller'
          })
          .catch(() => null)
      }
      const target = `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}`
      navigateFromHostList(target)
    },
    [client, connState, hostId, navigateFromHostList]
  )

  const openFloatingWorkspace = useCallback(() => {
    // Why: no worktree.activate here — the floating sentinel has no worktree
    // record; session.tabs.list hydrates its host-owned tabs on open.
    navigateFromHostList(floatingWorkspaceSessionPath(hostId))
  }, [hostId, navigateFromHostList])

  const handleSortChange = useCallback(
    (value: MobileSortMode) => {
      persistViewSettings({ sortMode: value })
    },
    [persistViewSettings]
  )

  const toggleHideSleeping = useCallback(() => {
    persistViewSettings({ hideSleeping: !viewStateRef.current.hideSleeping })
  }, [persistViewSettings])

  const toggleHideDefaultBranch = useCallback(() => {
    persistViewSettings({ hideDefaultBranch: !viewStateRef.current.hideDefaultBranch })
  }, [persistViewSettings])

  const toggleRepoFilter = useCallback(
    (repoId: string) => {
      const next = new Set(viewStateRef.current.filterRepoIds)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      persistViewSettings({ filterRepoIds: [...next] })
    },
    [persistViewSettings]
  )

  const clearFilters = useCallback(() => {
    persistViewSettings({ hideSleeping: false, hideDefaultBranch: false, filterRepoIds: [] })
  }, [persistViewSettings])

  const activeFilterCount = useMemo(() => {
    let count = 0
    if (filters.hideSleeping) {
      count++
    }
    if (filters.hideDefaultBranch) {
      count++
    }
    count += filters.filterRepoIds.size
    return count
  }, [filters])
  const selectedSortLabel =
    SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? 'Recent'

  const handleGroupChange = useCallback(
    (value: MobileGroupMode) => {
      persistViewSettings({ groupMode: value })
    },
    [persistViewSettings]
  )

  const displayWorktrees = useMemo(() => {
    const base =
      connState === 'disconnected' || connState === 'reconnecting' || connState === 'auth-failed'
        ? lastKnownWorktrees
        : worktrees
    if (sleptIds.size === 0 && optimisticActiveWorktreeId === null) {
      return base
    }
    return base.map((w) => {
      const slept = sleptIds.has(w.worktreeId)
        ? { liveTerminalCount: 0, hasAttachedPty: false, status: 'inactive' as const }
        : null
      // Force the just-opened worktree active until the next poll confirms it, so the highlight doesn't lag.
      const active =
        optimisticActiveWorktreeId !== null
          ? { isActive: w.worktreeId === optimisticActiveWorktreeId }
          : null
      return slept || active ? { ...w, ...slept, ...active } : w
    })
  }, [connState, worktrees, lastKnownWorktrees, sleptIds, optimisticActiveWorktreeId])

  const toggleCollapsed = useCallback(
    (key: string) => {
      const next = new Set(viewStateRef.current.collapsedGroups)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [persistViewSettings]
  )
  const { sections, rawSections, uniqueRepos, uniqueRepoColors } = useWorkspaceSections({
    displayWorktrees,
    sortMode,
    filters,
    search,
    groupMode,
    pinnedIds,
    repoIdsByName,
    repoColorsByName,
    collapsedGroups,
    workspaceStatuses
  })
  const existingWorktreePaths = useMemo(() => worktrees.map((w) => w.path), [worktrees])

  const { sectionListRef, onScrollToIndexFailed } = useActiveWorktreeScroll(sections)

  const isReadOnly = connState === 'auth-failed'

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  if (compatVerdict.kind === 'blocked') {
    return <ProtocolBlockScreen verdict={compatVerdict} />
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topChrome}>
        <View style={styles.statusBar}>
          <Pressable
            style={styles.backButton}
            onPress={leaveHost}
            accessibilityRole="button"
            accessibilityLabel="Back to hosts"
            hitSlop={8}
          >
            <ChevronLeft size={22} color={colors.textPrimary} />
          </Pressable>
          {(() => {
            const headerVerdict = classifyConnection({
              state: connState,
              reconnectAttempts,
              lastConnectedAt
            })
            return (
              <>
                <View style={styles.hostIdentity}>
                  <StatusDot state={connState} verdict={headerVerdict} />
                  <Text style={styles.hostNameText} numberOfLines={1}>
                    {hostName || 'Host'}
                  </Text>
                </View>
                {connState !== 'connected' &&
                  (() => {
                    // Why: auth-failed has its own banner, so suppress the Reconnect button for that verdict.
                    const verdict = headerVerdict
                    const isError = isErrorVerdict(verdict)
                    const showReconnectButton = isError && hostId && verdict.kind !== 'auth-failed'
                    if (!showReconnectButton) {
                      return null
                    }
                    return (
                      <Pressable
                        style={styles.reconnectButton}
                        onPress={() => void forceReconnectHost(hostId!)}
                        hitSlop={8}
                      >
                        <Text style={styles.reconnectButtonText}>Reconnect</Text>
                      </Pressable>
                    )
                  })()}
              </>
            )
          })()}
          {!embedded && floatingWorkspaceEnabled ? (
            <Pressable
              style={[
                styles.floatingWorkspaceHeaderButton,
                connState !== 'connected' && styles.toolbarIconDisabled
              ]}
              onPress={openFloatingWorkspace}
              disabled={connState !== 'connected'}
              accessibilityRole="button"
              accessibilityLabel="Floating Workspace"
              hitSlop={8}
            >
              <SquareTerminal
                size={18}
                color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
              />
            </Pressable>
          ) : null}
          {embedded && onHideSidebar ? (
            <Pressable
              style={styles.sidebarCollapseButton}
              onPress={onHideSidebar}
              accessibilityRole="button"
              accessibilityLabel="Hide sidebar"
              hitSlop={8}
            >
              <PanelLeftClose size={14} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>

        {/* Filter/sort/group toolbar */}
        {embedded ? (
          <View style={styles.embeddedToolbar}>
            <View style={styles.embeddedToolbarRow}>
              <Pressable
                style={[
                  styles.filterChip,
                  styles.embeddedFilterChip,
                  activeFilterCount > 0 && styles.filterChipActive
                ]}
                onPress={() => setShowFilterModal(true)}
                accessibilityRole="button"
                accessibilityLabel={`Filter workspaces${activeFilterCount > 0 ? `, ${activeFilterCount} active` : ''}`}
              >
                <Filter
                  size={12}
                  color={activeFilterCount > 0 ? colors.textPrimary : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.filterChipText,
                    activeFilterCount > 0 && styles.filterChipTextActive
                  ]}
                  numberOfLines={1}
                >
                  Filter{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.modeButton, styles.embeddedModeButton]}
                onPress={() => setShowSortPicker(true)}
                accessibilityRole="button"
                accessibilityLabel={`Sort by ${selectedSortLabel}`}
              >
                <SlidersHorizontal size={14} color={colors.textSecondary} />
                <Text style={styles.sortLabel} numberOfLines={1}>
                  {selectedSortLabel}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.modeButton, styles.embeddedModeButton]}
                onPress={() => setShowGroupPicker(true)}
                accessibilityRole="button"
                accessibilityLabel="Group workspaces"
              >
                <Layers size={14} color={colors.textSecondary} />
                <Text style={styles.sortLabel} numberOfLines={1}>
                  {groupMode === 'none'
                    ? 'Group'
                    : groupMode === 'workspaceStatus'
                      ? 'Status'
                      : groupMode === 'repo'
                        ? 'Repo'
                        : 'PR'}
                </Text>
              </Pressable>
            </View>

            <View style={styles.embeddedToolbarRow}>
              <Pressable
                style={[
                  styles.embeddedToolbarIconButton,
                  connState !== 'connected' && styles.toolbarIconDisabled
                ]}
                onPress={() => navigateFromHostList(`/h/${hostId}/accounts`)}
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel="Accounts"
              >
                <UserCircle
                  size={16}
                  color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                />
              </Pressable>

              <Pressable
                style={[
                  styles.embeddedToolbarIconButton,
                  connState !== 'connected' && styles.toolbarIconDisabled
                ]}
                onPress={() => navigateFromHostList(`/h/${hostId}/tasks`)}
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel="Tasks"
              >
                <List
                  size={16}
                  color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                />
              </Pressable>

              {floatingWorkspaceEnabled ? (
                <Pressable
                  style={[
                    styles.embeddedToolbarIconButton,
                    connState !== 'connected' && styles.toolbarIconDisabled
                  ]}
                  onPress={openFloatingWorkspace}
                  disabled={connState !== 'connected'}
                  accessibilityRole="button"
                  accessibilityLabel="Floating Workspace"
                >
                  <SquareTerminal
                    size={18}
                    color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                  />
                </Pressable>
              ) : null}

              <Pressable
                style={[
                  styles.embeddedToolbarIconButton,
                  connState !== 'connected' && styles.toolbarIconDisabled
                ]}
                onPress={openNewWorktreeModal}
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel="New workspace"
              >
                <Plus
                  size={16}
                  color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
                />
              </Pressable>

              <Pressable
                style={styles.embeddedToolbarIconButton}
                onPress={() => setShowSearch((s) => !s)}
                accessibilityRole="button"
                accessibilityLabel={showSearch ? 'Close search' : 'Search workspaces'}
              >
                {showSearch ? (
                  <X size={16} color={colors.textSecondary} />
                ) : (
                  <Search size={16} color={colors.textSecondary} />
                )}
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.toolbar}>
            <Pressable
              style={[styles.filterChip, activeFilterCount > 0 && styles.filterChipActive]}
              onPress={() => setShowFilterModal(true)}
            >
              <Filter
                size={12}
                color={activeFilterCount > 0 ? colors.textPrimary : colors.textSecondary}
              />
              <Text
                style={[
                  styles.filterChipText,
                  activeFilterCount > 0 && styles.filterChipTextActive
                ]}
              >
                Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </Text>
            </Pressable>

            <Pressable style={styles.modeButton} onPress={() => setShowSortPicker(true)}>
              <SlidersHorizontal size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel} numberOfLines={1}>
                {selectedSortLabel}
              </Text>
            </Pressable>

            <Pressable style={styles.modeButton} onPress={() => setShowGroupPicker(true)}>
              <Layers size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel} numberOfLines={1}>
                {groupMode === 'none'
                  ? 'Group'
                  : groupMode === 'workspaceStatus'
                    ? 'Status'
                    : groupMode === 'repo'
                      ? 'Repo'
                      : 'PR'}
              </Text>
            </Pressable>

            <View style={styles.toolbarSpacer} />

            <Pressable
              style={styles.searchToggle}
              onPress={() => navigateFromHostList(`/h/${hostId}/accounts`)}
              disabled={connState !== 'connected'}
            >
              <UserCircle
                size={16}
                color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
              />
            </Pressable>

            <Pressable
              style={styles.searchToggle}
              onPress={() => navigateFromHostList(`/h/${hostId}/tasks`)}
              disabled={connState !== 'connected'}
            >
              <List
                size={16}
                color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
              />
            </Pressable>

            <Pressable style={styles.searchToggle} onPress={() => setShowSearch((s) => !s)}>
              {showSearch ? (
                <X size={16} color={colors.textSecondary} />
              ) : (
                <Search size={16} color={colors.textSecondary} />
              )}
            </Pressable>
          </View>
        )}
      </View>

      {/* Auth failed banner */}
      {connState === 'auth-failed' && (
        <AuthFailedBanner
          canRetry={!!hostId}
          onRetry={() => hostId && void forceReconnectHost(hostId)}
          onRepair={() => router.push('/pair-scan')}
          onRemove={() => setConfirmRemoveHost(true)}
        />
      )}

      {/* Search bar */}
      {showSearch && (
        <View style={styles.searchBar}>
          <MobileSearchField
            value={search}
            onChangeText={setSearch}
            placeholder="Search worktrees…"
            autoFocus
            // Why: new key per open remounts the focus effect across rapid toggles so the keyboard reappears.
            focusKey={showSearch}
            accessibilityLabel="Search worktrees"
          />
        </View>
      )}

      {/* Loading state */}
      {((connState === 'connecting' || connState === 'reconnecting') &&
        displayWorktrees.length === 0) ||
      (connState === 'connected' && !worktreesLoaded && displayWorktrees.length === 0) ? (
        <View style={styles.centered}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : null}

      {/* Empty state */}
      {connState === 'connected' && worktreesLoaded && sections.length === 0 && (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>
            {search
              ? 'No matching worktrees'
              : activeFilterCount > 0
                ? 'No worktrees match filters'
                : 'No worktrees'}
          </Text>
        </View>
      )}

      {sections.length > 0 && (
        <SectionList
          ref={sectionListRef}
          sections={sections}
          keyExtractor={(w) => w.sectionListKey ?? w.worktreeId}
          stickySectionHeadersEnabled={false}
          // Why: keep the search IME up while tapping clear / scrolling results.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScrollToIndexFailed={onScrollToIndexFailed}
          // Why: edge-to-edge under the system nav bar; insets.bottom keeps the last row above it.
          contentContainerStyle={[
            styles.list,
            // Reserve room so the last row stays tappable above the phone's floating "+" (embedded uses the toolbar +).
            { paddingBottom: (embedded ? spacing.lg : FAB_SIZE + spacing.xl) + insets.bottom },
            isWideLayout &&
              !embedded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
          ]}
          renderSectionHeader={({ section }) => {
            if (!section.title) {
              return null
            }
            const isCollapsed = collapsedGroups.has(section.key)
            const rawSection = rawSections.find((s) => s.key === section.key)
            const count = rawSection?.data.length ?? 0
            const repoSectionColor =
              groupMode === 'repo' ? uniqueRepoColors.get(section.title) : null
            const repoSectionIcon = groupMode === 'repo' ? repoIconsByName.get(section.title) : null
            return (
              <Pressable style={styles.sectionHeader} onPress={() => toggleCollapsed(section.key)}>
                {isCollapsed ? (
                  <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
                ) : (
                  <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                {section.icon === 'pin' && (
                  <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                {groupMode === 'repo' ? (
                  <View style={styles.sectionRepoIcon}>
                    <MobileRepoIcon
                      repoIcon={repoSectionIcon}
                      size={14}
                      color={repoSectionColor ?? colors.textSecondary}
                    />
                  </View>
                ) : null}
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionCount}>{count}</Text>
              </Pressable>
            )
          }}
          ItemSeparatorComponent={ListSeparator}
          // Why (#8498): manual pull-to-refresh forces a fresh snapshot after a stale-cache reconnect.
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textSecondary}
              colors={[colors.textSecondary]}
            />
          }
          renderItem={({ item }) => (
            <WorktreeListRow
              item={item}
              isReadOnly={isReadOnly}
              now={now}
              status={getWorktreeStatus(item)}
              repoColor={uniqueRepoColors.get(item.repo) ?? repoColor(item.repo)}
              repoIcon={repoIconsByName.get(item.repo) ?? null}
              hideRepo={groupMode === 'repo'}
              onPress={openWorktreeSession}
              onLongPress={item.workspaceKind === 'folder-workspace' ? undefined : setActionTarget}
              onToggleLineage={(row) =>
                toggleCollapsed(getMobileWorkspaceLineageGroupKey(row.worktreeId))
              }
            />
          )}
        />
      )}

      {/* Floating "new workspace" button — phone only; embedded sidebars keep the toolbar +. */}
      {!embedded && (
        <NewWorkspaceFab onPress={openNewWorktreeModal} disabled={connState !== 'connected'} />
      )}

      <PickerModal
        visible={showSortPicker}
        title="Sort By"
        options={SORT_OPTIONS}
        selected={sortMode}
        onSelect={handleSortChange}
        onClose={() => setShowSortPicker(false)}
      />

      <PickerModal
        visible={showGroupPicker}
        title="Group By"
        options={GROUP_OPTIONS}
        selected={groupMode}
        onSelect={handleGroupChange}
        onClose={() => setShowGroupPicker(false)}
      />

      <BottomDrawer visible={showFilterModal} onClose={() => setShowFilterModal(false)}>
        <View style={styles.filterModalHeader}>
          <Text style={styles.filterModalTitle}>Filter</Text>
          {activeFilterCount > 0 && (
            <Pressable onPress={clearFilters}>
              <Text style={styles.clearFiltersText}>Clear filters</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.filterSectionLabel}>Workspaces</Text>
        <View style={styles.filterGroup}>
          <Pressable style={styles.filterRow} onPress={toggleHideSleeping}>
            <Text style={styles.filterRowText}>Hide sleeping</Text>
            {filters.hideSleeping && <Check size={14} color={colors.textPrimary} />}
          </Pressable>
          <View style={styles.filterSeparator} />
          <Pressable style={styles.filterRow} onPress={toggleHideDefaultBranch}>
            <Text style={styles.filterRowText}>Hide default branch</Text>
            {filters.hideDefaultBranch && <Check size={14} color={colors.textPrimary} />}
          </Pressable>
        </View>

        {uniqueRepos.length > 1 && (
          <>
            <Text style={styles.filterSectionLabel}>Repositories</Text>
            <View style={styles.filterGroup}>
              {uniqueRepos.map((repo, i) => (
                <View key={repo.id}>
                  {i > 0 && <View style={styles.filterSeparator} />}
                  <Pressable style={styles.filterRow} onPress={() => toggleRepoFilter(repo.id)}>
                    <View style={[styles.filterRepoDot, { backgroundColor: repo.color }]} />
                    <Text style={styles.filterRowText} numberOfLines={1}>
                      {repo.name}
                    </Text>
                    {filters.filterRepoIds.has(repo.id) && (
                      <Check size={14} color={colors.textPrimary} />
                    )}
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        )}
      </BottomDrawer>

      {/* Worktree long-press action sheet (inline confirm to avoid double-Modal lag) */}
      <BottomDrawer
        visible={actionTarget != null}
        onClose={() => {
          setConfirmDelete(null)
          setActionTarget(null)
        }}
      >
        {confirmDelete ? (
          <View>
            <View style={styles.confirmContent}>
              <Text style={styles.confirmTitle}>Delete Worktree</Text>
              <Text style={styles.confirmMessage}>
                Delete "{confirmDelete.displayName || confirmDelete.repo}" ({confirmDelete.branch})?
              </Text>
            </View>
            <View style={styles.confirmButtons}>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnCancel,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => setConfirmDelete(null)}
              >
                <Text style={styles.confirmBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnDestructive,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => {
                  if (confirmDelete) {
                    void handleDeleteWorktree(confirmDelete)
                  }
                  setConfirmDelete(null)
                  setActionTarget(null)
                }}
              >
                <Text style={styles.confirmBtnDestructiveText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <ActionSheetContent
            title={actionTarget ? actionTarget.displayName || actionTarget.repo : undefined}
            message={actionTarget?.branch}
            actions={
              actionTarget
                ? [
                    ...buildWorktreeNavigationActions({
                      hostId,
                      worktreeId: actionTarget.worktreeId,
                      worktreeName: actionTarget.displayName || actionTarget.repo,
                      hostCapabilities,
                      navigate: navigateFromHostList,
                      onDone: () => setActionTarget(null)
                    }),
                    {
                      label: 'Sleep',
                      icon: Moon,
                      onPress: () => {
                        if (client) {
                          setSleptIds((prev) => new Set(prev).add(actionTarget.worktreeId))
                          void client
                            .sendRequest('worktree.sleep', {
                              worktree: `id:${actionTarget.worktreeId}`
                            })
                            .catch(() => null)
                        }
                        setActionTarget(null)
                      }
                    },
                    {
                      label: isWorktreePinned(actionTarget, pinnedIds) ? 'Unpin' : 'Pin',
                      onPress: () => {
                        togglePin(actionTarget.worktreeId)
                        setActionTarget(null)
                      }
                    },
                    {
                      label: 'Delete',
                      destructive: true,
                      onPress: () => setConfirmDelete(actionTarget)
                    }
                  ]
                : []
            }
          />
        )}
      </BottomDrawer>

      {/* Host remove confirmation */}
      <ConfirmModal
        visible={confirmRemoveHost}
        title="Remove Host"
        message={`Remove "${hostName}"? You can re-pair later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemoveHost()}
        onCancel={() => setConfirmRemoveHost(false)}
      />

      <NewWorktreeModalController
        ref={newWorktreeModalRef}
        routeVisible={showNewWorktree}
        client={client}
        hostId={hostId}
        existingWorktreePaths={existingWorktreePaths}
        existingWorktrees={worktrees}
        onVisibleChange={(visible) => {
          newWorktreeModalVisibleRef.current = visible
        }}
        onCreated={(worktreeId, worktreeName) => {
          void fetchWorktrees({ allowDuringModal: true })
          const params = new URLSearchParams({ name: worktreeName, created: '1' })
          navigateFromHostList(
            `/h/${hostId}/session/${encodeURIComponent(worktreeId)}?${params.toString()}`
          )
        }}
        onRouteVisibleChange={setShowNewWorktreeVisible}
      />
    </SafeAreaView>
  )
}

// On wide layouts the sidebar hosts the list, so this route is just the empty detail pane.
export default function HostWorktreeRoute() {
  const { isWideLayout } = useResponsiveLayout()
  if (isWideLayout) {
    return <WorkspaceDetailPlaceholder />
  }
  return <HostScreen />
}

function ListSeparator() {
  return <View style={styles.separator} />
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 34,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.lg
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  sidebarCollapseButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    marginLeft: spacing.xs
  },
  hostIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    marginRight: spacing.md
  },
  hostNameText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  reconnectButton: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  reconnectButtonText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  embeddedToolbar: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  embeddedToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  embeddedFilterChip: {
    flex: 1,
    minWidth: 0,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 0
  },
  embeddedModeButton: {
    flex: 1,
    minWidth: 0,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 0
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  filterChipActive: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  filterChipText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  filterChipTextActive: {
    color: colors.textPrimary
  },
  modeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sortLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.textSecondary
  },
  toolbarSpacer: {
    flex: 1
  },
  floatingWorkspaceHeaderButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs
  },
  embeddedToolbarIconButton: {
    flex: 1,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  toolbarIconDisabled: {
    opacity: 0.6
  },
  searchToggle: {
    padding: spacing.xs
  },
  searchBar: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  list: {
    paddingBottom: spacing.lg
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionIcon: {
    marginRight: spacing.xs
  },
  sectionRepoIcon: {
    marginRight: spacing.xs
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  sectionCount: {
    fontSize: 11,
    color: colors.textMuted,
    marginLeft: spacing.xs
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 24,
    marginRight: spacing.lg
  },
  filterModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  filterModalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  clearFiltersText: {
    fontSize: 13,
    color: colors.textSecondary
  },
  filterSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  filterGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: spacing.md
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2,
    gap: spacing.sm
  },
  filterRowText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  filterSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  filterRepoDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  confirmContent: {
    paddingBottom: spacing.lg
  },
  confirmTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  confirmMessage: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: 10,
    alignItems: 'center'
  },
  confirmBtnCancel: {
    backgroundColor: colors.bgPanel
  },
  confirmBtnDestructive: {
    backgroundColor: colors.statusRed
  },
  confirmBtnPressed: {
    opacity: 0.7
  },
  confirmBtnCancelText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textSecondary
  },
  confirmBtnDestructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: '#fff'
  }
})
