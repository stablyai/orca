import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  ActivityIndicator,
  TextInput
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import {
  Search,
  X,
  Pin,
  GitBranch,
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
  PanelLeftClose
} from 'lucide-react-native'
import type { RpcClient } from '../../../src/transport/rpc-client'
import { loadHosts, updateLastConnected, removeHost } from '../../../src/transport/host-store'
import {
  useHostClient,
  useCloseHost,
  useForceReconnect,
  useReconnectAttempt,
  useLastConnectedAt
} from '../../../src/transport/client-context'
import {
  classifyConnection,
  type ConnectionVerdict
} from '../../../src/transport/connection-health'
import type { RpcSuccess } from '../../../src/transport/types'
import { StatusDot } from '../../../src/components/StatusDot'
import { NewWorktreeModalController } from '../../../src/components/NewWorktreeModalController'
import { MobileRepoIcon } from '../../../src/components/MobileRepoIcon'
import { WorktreeListRow } from '../../../src/components/WorktreeListRow'
import { useNow } from '../../../src/hooks/use-now'
import { useActiveWorktreeScroll } from '../../../src/hooks/use-active-worktree-scroll'
import type { RepoIcon } from '../../../../src/shared/repo-icon'
import { PickerModal } from '../../../src/components/PickerModal'
import { ActionSheetContent } from '../../../src/components/ActionSheetModal'
import { ConfirmModal } from '../../../src/components/ConfirmModal'
import { BottomDrawer } from '../../../src/components/BottomDrawer'
import { ProtocolBlockScreen } from '../../../src/components/ProtocolBlockScreen'
import { AuthFailedBanner } from '../../../src/components/AuthFailedBanner'
import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { getCachedWorktrees } from '../../../src/cache/worktree-cache'
import { setCachedRepos } from '../../../src/cache/repo-cache'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'
import { leaveHostRoute } from '../../../src/host-route-exit'
import { evaluateCompat, type CompatVerdict } from '../../../src/transport/protocol-compat'
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
  buildSections,
  getWorktreeStatus,
  isWorktreePinned,
  type FilterState,
  type Worktree
} from '../../../src/worktree/workspace-list-sections'
import { areWorktreeListsEqual } from '../../../src/worktree/worktree-list-snapshot'
import { repoColor } from '../../../src/worktree/repo-color'
import {
  WORKSPACE_GROUP_OPTIONS as GROUP_OPTIONS,
  WORKSPACE_SORT_OPTIONS as SORT_OPTIONS
} from '../../../src/worktree/workspace-list-picker-options'
import type { DesktopStatus, RepoSummary } from '../../../src/worktree/host-worktree-rpc-types'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return v.kind === 'warning' || v.kind === 'unreachable' || v.kind === 'auth-failed'
}

const REPO_METADATA_REFRESH_MS = 60_000

type HostScreenProps = {
  // Why: when true, this worktree list is rendered as the persistent tablet
  // sidebar by the host layout rather than as its own routed screen. That
  // swaps the back button for a hide-sidebar control, drives data fetching
  // from a plain mount effect (the sidebar is never the "focused" route), and
  // opens sessions into the detail pane instead of pushing a new full screen.
  embedded?: boolean
  // Route params aren't in scope when rendered from the layout, so the caller
  // passes hostId/action explicitly; falls back to the local route params.
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
  // Why: cap and center the worktree list on wide/tablet canvases; on phones
  // isWideLayout is false so the list stays edge-to-edge as before. When
  // embedded as the sidebar the list already lives in a narrow pane, so the
  // cap is skipped (see the SectionList contentContainerStyle below).
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const [initialCache] = useState(() =>
    hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
  )
  // Why: shared client per host owned by RpcClientProvider. See
  // docs/mobile-shared-client-per-host.md.
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
  // Why: opening a worktree activates it on the host, but the active-row
  // highlight otherwise waits for the next worktree.ps poll to reflect it.
  // Track the locally-opened worktree so the highlight moves instantly.
  const [optimisticActiveWorktreeId, setOptimisticActiveWorktreeId] = useState<string | null>(null)
  // One tick drives every visible agent row's relative timestamp.
  const now = useNow(30_000)
  const [repoColorsByName, setRepoColorsByName] = useState<Map<string, string>>(new Map())
  const [repoIconsByName, setRepoIconsByName] = useState<Map<string, RepoIcon>>(new Map())
  const [hostName, setHostName] = useState('')
  const [error, setError] = useState('')
  const [compatVerdict, setCompatVerdict] = useState<CompatVerdict>({ kind: 'ok' })
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
  // displayName → repo id, populated from repo.list. The filter model keys on
  // repo ids (desktop's PersistedUIState), but the section headers/rows key on
  // displayName, so we bridge the two here.
  const [repoIdsByName, setRepoIdsByName] = useState<Map<string, string>>(new Map())

  // Modals
  const [showSortPicker, setShowSortPicker] = useState(false)
  const [showGroupPicker, setShowGroupPicker] = useState(false)
  const [showFilterModal, setShowFilterModal] = useState(false)
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [confirmRemoveHost, setConfirmRemoveHost] = useState(false)
  const [routeActionState, setRouteActionState] = useState(() =>
    createInitialHostRouteActionState(action)
  )
  const [sleptIds, setSleptIds] = useState<Set<string>>(new Set())

  const leaveHost = useCallback(() => {
    leaveHostRoute(router)
  }, [router])

  // Persisted pin state
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Why: snapshot of the synced view settings so the focus-effect ui.get merge
  // and the optimistic ui.set writes read the latest values without forcing the
  // callbacks to re-create on every state change.
  const viewStateRef = useRef<MobileViewState>({
    groupMode: 'repo',
    sortMode: 'recent',
    hideSleeping: false,
    hideDefaultBranch: false,
    filterRepoIds: [],
    collapsedGroups: []
  })

  // Keep the snapshot ref aligned with the individual view-setting states.
  useEffect(() => {
    viewStateRef.current = {
      groupMode,
      sortMode,
      hideSleeping: filters.hideSleeping,
      hideDefaultBranch: filters.hideDefaultBranch,
      filterRepoIds: [...filters.filterRepoIds],
      collapsedGroups: [...collapsedGroups]
    }
  }, [groupMode, sortMode, filters, collapsedGroups])

  // Apply a MobileViewState (e.g. from a desktop ui.get) onto the individual
  // states and the snapshot ref in one shot.
  const applyViewState = useCallback((next: MobileViewState) => {
    viewStateRef.current = next
    setGroupMode(next.groupMode)
    setSortMode(next.sortMode)
    setCollapsedGroups(new Set(next.collapsedGroups))
    setFilters({
      filterRepoIds: new Set(next.filterRepoIds),
      hideSleeping: next.hideSleeping,
      hideDefaultBranch: next.hideDefaultBranch
    })
  }, [])

  // Optimistically apply a partial change locally, then push the full mapped
  // settings to the desktop's shared store via ui.set so both apps stay in sync.
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
  // Why: `action=newWorktree` is a route-derived open edge. Resolve it before
  // commit, but don't reopen after the user closes while the same URL remains.
  if (resolvedRouteActionState !== routeActionState) {
    setRouteActionState(resolvedRouteActionState)
  }
  const showNewWorktree = resolvedRouteActionState.showNewWorktree
  const setShowNewWorktreeVisible = useCallback((visible: boolean) => {
    setRouteActionState((current) => setHostRouteNewWorktreeVisible(current, visible))
  }, [])

  // Load persisted pins from the local cache. View settings are no longer
  // stored locally — they sync from the desktop's shared store via ui.get.
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

  // Read the desktop's shared view settings (PersistedUIState) and merge them
  // onto local state. Runs on connect and on screen focus so changes made on
  // desktop appear on the phone.
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

  // Why: keep clientRef in sync so existing imperative call sites work
  // unchanged. Also re-seed the cached worktree list on hostId change
  // since the useState initializer only runs on first mount.
  useEffect(() => {
    clientRef.current = client
  }, [client])

  useEffect(() => {
    setHostName('')
    setError('')
    setCompatVerdict({ kind: 'ok' })
    setRepoColorsByName(new Map())
    setRepoIconsByName(new Map())
    repoMetadataFetchedAtRef.current = 0
    // Why: re-seed from the current host's cache on every hostId change.
    // The useState initializer only runs on first mount, so if Expo Router
    // reuses this screen with a different hostId, we must reset here.
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
      const requestClient = client
      const requestHostId = hostId
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
      // The embedded sidebar polls for the whole split-view session; keep slow
      // remote hosts from stacking overlapping expensive list requests.
      if (fetchWorktreesInFlightRef.current) {
        return
      }
      fetchWorktreesInFlightRef.current = true
      const requestClient = client
      const requestHostId = hostId

      try {
        // Why: worktree.ps defaults to 200 and silently truncates; match the
        // desktop's high cap so large hosts don't drop workspaces on mobile.
        const response = await requestClient.sendRequest('worktree.ps', { limit: 10000 })
        if (clientRef.current !== requestClient || hostId !== requestHostId) {
          return
        }
        if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
          return
        }
        if (response.ok) {
          const result = (response as RpcSuccess).result as { worktrees: Worktree[] }
          // Why: large hosts can return identical worktree.ps snapshots every
          // poll. Preserving the existing array keeps SectionList/sort rebuilds
          // off the JS tap path unless something actually changed.
          setWorktrees((current) =>
            areWorktreeListsEqual(current, result.worktrees) ? current : result.worktrees
          )
          setLastKnownWorktrees((current) =>
            areWorktreeListsEqual(current, result.worktrees) ? current : result.worktrees
          )
          setWorktreesLoaded(true)
          // Drop the optimistic active override once the host confirms it (the
          // activate RPC has landed and worktree.ps now reports it active), so we
          // stop overriding and respect any later desktop-driven change.
          setOptimisticActiveWorktreeId((pending) =>
            pending && result.worktrees.some((w) => w.worktreeId === pending && w.isActive)
              ? null
              : pending
          )

          // Clear optimistic sleep overrides once the server confirms the
          // worktree is actually inactive (liveTerminalCount dropped to 0).
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

          // Sync local pin state from server so desktop-initiated pins/unpins
          // are reflected without relying on stale AsyncStorage.
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

  // Why: read desktop's protocol version from status.get on every connect
  // and re-evaluate compatibility. If the desktop declares this mobile
  // build too old (or vice versa via the local minimum), the host detail
  // screen swaps to a hard-block screen instead of the worktree list.
  // Today's compat constants are wide-open so this never blocks; the wire
  // format is in place to flip a switch in a future release.
  useEffect(() => {
    if (connState !== 'connected' || !client) {
      return
    }
    let cancelled = false
    const requestClient = client
    void (async () => {
      try {
        const response = await requestClient.sendRequest('status.get')
        if (cancelled || clientRef.current !== requestClient) {
          return
        }
        if (!response.ok) {
          return
        }
        const status = (response as RpcSuccess).result as DesktopStatus
        const verdict = evaluateCompat({
          desktopProtocolVersion: status.protocolVersion,
          desktopMinCompatibleMobileVersion: status.minCompatibleMobileVersion
        })
        setCompatVerdict(verdict)
        if (verdict.kind === 'blocked') {
          // Why: deterministic breadcrumb so support can confirm a block
          // actually fired (vs a render bug). No PII — just version ints.
          console.warn('[protocol-compat] blocked', {
            reason: verdict.reason,
            desktopVersion: verdict.desktopVersion,
            requiredMobileVersion: verdict.requiredMobileVersion,
            requiredDesktopVersion: verdict.requiredDesktopVersion
          })
        }
      } catch {
        // Why: rare path — sendRequest can throw on transport tear-down.
        // Treat as transient; verdict stays at previous value.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connState, client])

  useFocusEffect(
    useCallback(() => {
      // The embedded sidebar drives its own polling below; focus never fires
      // for it since it isn't a routed screen.
      if (embedded || connState !== 'connected') {
        return
      }
      void fetchWorktrees()
      void fetchRepoMetadata()
      // Pull desktop's shared view settings on focus so desktop-side changes
      // show up here without a manual refresh.
      void syncViewSettingsFromDesktop()
      // Why: React Navigation keeps previous stack screens mounted; only
      // poll the host list while this route is visible.
      const interval = setInterval(() => {
        void fetchWorktrees()
        void fetchRepoMetadata()
      }, 3000)
      return () => clearInterval(interval)
    }, [embedded, connState, fetchWorktrees, fetchRepoMetadata, syncViewSettingsFromDesktop])
  )

  // Why: as the persistent tablet sidebar this list is never the focused
  // route, so useFocusEffect won't fetch/poll. Mirror that behavior from a
  // plain mount effect while connected instead.
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
    // Why: close the shared client first so its WebSocket is gone before
    // the host record disappears; otherwise the next loadHosts() the
    // provider does (e.g. on remount) wouldn't find this host but the
    // socket would still be open, leaking state.
    closeHostClient(hostId)
    await removeHost(hostId)
    leaveHost()
  }, [hostId, leaveHost, closeHostClient])

  const navigateFromHostList = useCallback(
    (target: string) => {
      if (!embedded) {
        router.push(target)
        return
      }
      const targetPath = target.split('?')[0] ?? target
      if (pathname === targetPath) {
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
      // Highlight the row immediately; the next worktree.ps poll confirms it.
      setOptimisticActiveWorktreeId(item.worktreeId)
      if (client && connState === 'connected') {
        void client
          .sendRequest('worktree.activate', {
            worktree: `id:${item.worktreeId}`
          })
          .catch(() => null)
      }
      const target = `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}`
      navigateFromHostList(target)
    },
    [client, connState, hostId, navigateFromHostList]
  )

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
      // Force the just-opened worktree active (and the rest inactive) until the
      // next poll confirms it, so the highlight doesn't lag the navigation.
      const active =
        optimisticActiveWorktreeId !== null
          ? { isActive: w.worktreeId === optimisticActiveWorktreeId }
          : null
      return slept || active ? { ...w, ...slept, ...active } : w
    })
  }, [connState, worktrees, lastKnownWorktrees, sleptIds, optimisticActiveWorktreeId])

  const uniqueRepos = useMemo(() => {
    const repos = new Map<string, { id: string; color: string }>()
    for (const w of displayWorktrees) {
      if (!repos.has(w.repo)) {
        repos.set(w.repo, {
          id: repoIdsByName.get(w.repo) ?? w.repoId,
          color: repoColorsByName.get(w.repo) ?? repoColor(w.repo)
        })
      }
    }
    return [...repos.entries()].map(([name, { id, color }]) => ({ name, id, color }))
  }, [displayWorktrees, repoColorsByName, repoIdsByName])

  const uniqueRepoColors = useMemo(
    () => new Map(uniqueRepos.map((repo) => [repo.name, repo.color])),
    [uniqueRepos]
  )

  const toggleCollapsed = useCallback(
    (title: string) => {
      const next = new Set(viewStateRef.current.collapsedGroups)
      if (next.has(title)) {
        next.delete(title)
      } else {
        next.add(title)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [persistViewSettings]
  )

  const rawSections = useMemo(
    () => buildSections(displayWorktrees, sortMode, filters, search, groupMode, pinnedIds),
    [displayWorktrees, sortMode, filters, search, groupMode, pinnedIds]
  )

  const sections = useMemo(
    () =>
      rawSections.map((s) => ({
        ...s,
        data: collapsedGroups.has(s.title) ? [] : s.data
      })),
    [rawSections, collapsedGroups]
  )
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
                    // Why: status label removed in favor of just the dot +
                    // Reconnect button — the home screen already surfaces the
                    // verdict text per host, and the dot color already
                    // signals severity here. Auth-failed routes through its
                    // dedicated banner so we still want to suppress the
                    // Reconnect button for that case.
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
                style={[styles.sortButton, styles.embeddedModeButton]}
                onPress={() => setShowSortPicker(true)}
                accessibilityRole="button"
                accessibilityLabel={`Sort by ${SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? 'Recent'}`}
              >
                <SlidersHorizontal size={14} color={colors.textSecondary} />
                <Text style={styles.sortLabel} numberOfLines={1}>
                  {SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? 'Recent'}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.groupButton, styles.embeddedModeButton]}
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

            <Pressable style={styles.sortButton} onPress={() => setShowSortPicker(true)}>
              <SlidersHorizontal size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel}>
                {SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? 'Recent'}
              </Text>
            </Pressable>

            <Pressable style={styles.groupButton} onPress={() => setShowGroupPicker(true)}>
              <Layers size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel}>
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

            <Pressable
              style={styles.newButton}
              onPress={openNewWorktreeModal}
              disabled={connState !== 'connected'}
            >
              <Plus
                size={16}
                color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
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
          <Search size={14} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search worktrees…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <X size={14} color={colors.textSecondary} />
            </Pressable>
          )}
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

      {/* Worktree list */}
      {sections.length > 0 && (
        <SectionList
          ref={sectionListRef}
          sections={sections}
          keyExtractor={(w) => w.worktreeId}
          stickySectionHeadersEnabled={false}
          onScrollToIndexFailed={onScrollToIndexFailed}
          // Why: edge-to-edge — the list scrolls under the system nav bar
          // while reserving insets.bottom keeps the last worktree row reachable
          // above the Samsung 3-button nav / iOS home indicator.
          contentContainerStyle={[
            styles.list,
            { paddingBottom: spacing.lg + insets.bottom },
            isWideLayout &&
              !embedded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
          ]}
          renderSectionHeader={({ section }) => {
            if (!section.title) {
              return null
            }
            const isCollapsed = collapsedGroups.has(section.title)
            const rawSection = rawSections.find((s) => s.title === section.title)
            const count = rawSection?.data.length ?? 0
            const repoSectionColor =
              groupMode === 'repo' ? uniqueRepoColors.get(section.title) : null
            const repoSectionIcon = groupMode === 'repo' ? repoIconsByName.get(section.title) : null
            return (
              <Pressable
                style={styles.sectionHeader}
                onPress={() => toggleCollapsed(section.title)}
              >
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
            />
          )}
        />
      )}

      {/* Sort picker modal */}
      <PickerModal
        visible={showSortPicker}
        title="Sort By"
        options={SORT_OPTIONS}
        selected={sortMode}
        onSelect={handleSortChange}
        onClose={() => setShowSortPicker(false)}
      />

      {/* Group picker modal */}
      <PickerModal
        visible={showGroupPicker}
        title="Group By"
        options={GROUP_OPTIONS}
        selected={groupMode}
        onSelect={handleGroupChange}
        onClose={() => setShowGroupPicker(false)}
      />

      {/* Filter modal — matches desktop's Status + Repositories dropdown */}
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
                    {
                      label: 'Source Control',
                      icon: GitBranch,
                      onPress: () => {
                        const params = new URLSearchParams({
                          name: actionTarget.displayName || actionTarget.repo,
                          origin: 'host'
                        })
                        navigateFromHostList(
                          `/h/${hostId}/source-control/${encodeURIComponent(actionTarget.worktreeId)}?${params.toString()}`
                        )
                        setActionTarget(null)
                      }
                    },
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

// Default route export. On wide tablet/foldable canvases the worktree list is
// rendered as a persistent sidebar by the host layout, so the route itself
// becomes the empty detail pane until a workspace is opened. On phones it is
// the full-screen worktree list as before.
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
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  groupButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sortLabel: {
    fontSize: 12,
    color: colors.textSecondary
  },
  toolbarSpacer: {
    flex: 1
  },
  toolbarIconButton: {
    width: 32,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
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
  newButton: {
    padding: spacing.xs
  },
  searchToggle: {
    padding: spacing.xs
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    paddingVertical: 2
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
