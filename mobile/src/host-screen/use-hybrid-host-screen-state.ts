import { useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import { createInitialHostRouteActionState } from '../host-route-action-state'
import type { HostScreenHostState } from '../worktree/host-screen-host-state'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from '../worktree/mobile-workspace-statuses'
import type {
  MobileGroupMode,
  MobileSortMode,
  MobileViewState
} from '../worktree/workspace-view-settings'
import type { FilterState, Worktree } from '../worktree/workspace-list-sections'
import type { HostWorkspaceOperations } from '../worktree/host-workspace-operations'

export function useHybridHostScreenState(
  hostId: string | undefined,
  action: string | undefined,
  hostState: HostScreenHostState
) {
  const initialCache = hostId ? hostState.cachedWorkspaces(hostId) : null
  const workspaceOperationsRef = useRef<HostWorkspaceOperations | null>(null)
  const fetchWorktreesInFlightRef = useRef(false)
  const fetchRepoMetadataInFlightRef = useRef(new WeakSet<HostWorkspaceOperations>())
  const fetchRepoMetadataPendingRef = useRef(new WeakSet<HostWorkspaceOperations>())
  // Why: one silent catalog retry per relayed-transport binding, so a first attempt that raced
  // the shell's socket stays in the loading state instead of rendering a failure.
  const catalogWarmupSpentRef = useRef(new WeakSet<HostWorkspaceOperations>())
  const repoMetadataFetchedAtRef = useRef(0)
  const newWorktreeModalRef = useRef<{ open: () => void }>(null)
  const newWorktreeModalVisibleRef = useRef(false)
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [worktreesLoaded, setWorktreesLoaded] = useState(initialCache != null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [optimisticActiveWorktreeIdentity, setOptimisticActiveWorktreeIdentity] = useState<
    string | null
  >(null)
  const [repoColorsByName, setRepoColorsByName] = useState<Map<string, string>>(new Map())
  const [repoIconsByName, setRepoIconsByName] = useState<Map<string, RepoIcon>>(new Map())
  const [repoIdsByName, setRepoIdsByName] = useState<Map<string, string>>(new Map())
  // Why: the hosted bridge publishes no host labels, so these stay empty there (the binding omits
  // `listHostContext`) and its rows keep the single-host presentation.
  const [repoHostIdByRepoId, setRepoHostIdByRepoId] = useState<Map<string, ExecutionHostId>>(
    new Map()
  )
  const [hostLabelById, setHostLabelById] = useState<Map<ExecutionHostId, string>>(new Map())
  const [hostPlatform, setHostPlatform] = useState<NodeJS.Platform | null>(null)
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
    catalogWarmupSpentRef,
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
    workspaceOperationsRef,
    workspaceStatuses,
    worktrees,
    worktreesLoaded
  }
}

export type HybridHostScreenState = ReturnType<typeof useHybridHostScreenState>
