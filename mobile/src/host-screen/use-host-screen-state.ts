import { useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import { getCachedWorktrees } from '../cache/worktree-cache'
import { createInitialHostRouteActionState } from '../host-route-action-state'
import type { RpcClient } from '../transport/rpc-client'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from '../worktree/mobile-workspace-statuses'
import { WorktreeCatalogSnapshotClient } from '../worktree/worktree-catalog-snapshot-client'
import type {
  MobileGroupMode,
  MobileSortMode,
  MobileViewState
} from '../worktree/workspace-view-settings'
import type { FilterState, Worktree } from '../worktree/workspace-list-sections'

export function useHostScreenState(hostId: string | undefined, action: string | undefined) {
  const [initialCache] = useState(() =>
    hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
  )
  const clientRef = useRef<RpcClient | null>(null)
  const fetchWorktreesInFlightRef = useRef(false)
  // Why: useRef, not useMemo — React may discard memoized values, which would silently
  // reset the snapshot token this object exists to own.
  const worktreeCatalogRef = useRef(new WorktreeCatalogSnapshotClient())
  const fetchRepoMetadataInFlightRef = useRef(new WeakSet<RpcClient>())
  const fetchRepoMetadataPendingRef = useRef(new WeakSet<RpcClient>())
  const repoMetadataFetchedAtRef = useRef(0)
  const newWorktreeModalRef = useRef<{ open: () => void }>(null)
  const newWorktreeModalVisibleRef = useRef(false)
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [worktreesLoaded, setWorktreesLoaded] = useState(initialCache != null)
  // Why (STA-3123): error code of the last failed worktree.ps, so a broken catalog
  // path renders as a failure instead of an empty host. Cleared on the next success.
  const [catalogError, setCatalogError] = useState<string | null>(null)
  // Why: track the locally-opened worktree so the active-row highlight moves instantly instead of waiting for the next poll.
  const [optimisticActiveWorktreeIdentity, setOptimisticActiveWorktreeIdentity] = useState<
    string | null
  >(null)
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
    hideDefaultBranch: false,
    alwaysShowDefaultBranch: true
  })
  const [groupMode, setGroupMode] = useState<MobileGroupMode>('repo')
  const [workspaceStatuses, setWorkspaceStatuses] = useState<readonly WorkspaceStatusDefinition[]>(
    DEFAULT_MOBILE_WORKSPACE_STATUSES
  )
  // displayName → repo id: filters key on repo id, but section headers/rows key on displayName, so bridge the two.
  const [repoIdsByName, setRepoIdsByName] = useState<Map<string, string>>(new Map())
  // Host-label inputs for rows: repo → host, SSH/override labels, and the host's own platform.
  const [repoHostIdByRepoId, setRepoHostIdByRepoId] = useState<Map<string, ExecutionHostId>>(
    new Map()
  )
  const [hostLabelById, setHostLabelById] = useState<Map<ExecutionHostId, string>>(new Map())
  const [hostPlatform, setHostPlatform] = useState<NodeJS.Platform | null>(null)
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
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // Why: ref so the ui.get merge and ui.set writes read the latest values without re-creating callbacks on every state change.
  const viewStateRef = useRef<MobileViewState>({
    groupMode: 'repo',
    sortMode: 'recent',
    hideSleeping: false,
    hideDefaultBranch: false,
    alwaysShowDefaultBranch: true,
    filterRepoIds: [],
    collapsedGroups: [],
    workspaceStatuses: DEFAULT_MOBILE_WORKSPACE_STATUSES
  })

  return {
    actionTarget,
    catalogError,
    clientRef,
    collapsedGroups,
    confirmDelete,
    confirmRemoveHost,
    error,
    fetchRepoMetadataInFlightRef,
    fetchRepoMetadataPendingRef,
    fetchWorktreesInFlightRef,
    filters,
    groupMode,
    hostLabelById,
    hostName,
    hostPlatform,
    lastKnownWorktrees,
    newWorktreeModalRef,
    newWorktreeModalVisibleRef,
    optimisticActiveWorktreeIdentity,
    pinnedIds,
    repoColorsByName,
    repoHostIdByRepoId,
    repoIconsByName,
    repoIdsByName,
    repoMetadataFetchedAtRef,
    routeActionState,
    search,
    setActionTarget,
    setCatalogError,
    setCollapsedGroups,
    setConfirmDelete,
    setConfirmRemoveHost,
    setError,
    setFilters,
    setGroupMode,
    setHostLabelById,
    setHostName,
    setHostPlatform,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    setRepoColorsByName,
    setRepoHostIdByRepoId,
    setRepoIconsByName,
    setRepoIdsByName,
    setRouteActionState,
    setSearch,
    setShowFilterModal,
    setShowGroupPicker,
    setShowSearch,
    setShowSortPicker,
    setSleptIds,
    setSortMode,
    setWorkspaceStatuses,
    setWorktrees,
    setWorktreesLoaded,
    showFilterModal,
    showGroupPicker,
    showSearch,
    showSortPicker,
    sleptIds,
    sortMode,
    viewStateRef,
    workspaceStatuses,
    worktreeCatalogRef,
    worktrees,
    worktreesLoaded
  }
}

export type HostScreenState = ReturnType<typeof useHostScreenState>
