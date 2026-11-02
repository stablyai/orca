import { useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import { getCachedWorktrees } from '../cache/worktree-cache'
import { createInitialHostRouteActionState } from '../host-route-action-state'
import type { RpcClient } from '../transport/rpc-client'
import { WorktreeCatalogSnapshotClient } from '../worktree/worktree-catalog-snapshot-client'
import { INITIAL_MOBILE_VIEW, type MobileViewState } from '../worktree/workspace-view-settings'
import type { Worktree } from '../worktree/workspace-list-sections'
import type { ServedProjectSections } from '../worktree/project-sections-operations'
import type { SectionRepo } from '../worktree/workspace-list-types'
import { NO_SERVER_WORKSPACES, type ServerWorkspaces } from '../worktree/server-workspaces'

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
  const [hostName, setHostName] = useState('')
  // The stored name identity, loaded with the name so the header can label an offline host.
  const [hostStoredDescriptor, setHostStoredDescriptor] = useState<{
    personalName?: string
    lastKnownMachineName?: string
    lastKnownHostPlatform?: NodeJS.Platform
  } | null>(null)
  const [error, setError] = useState('')
  // An action that did not happen, said above the list rather than instead of it. Separate from
  // `error`, which is the screen's identity and is the one thing worth taking the whole view for.
  const [actionError, setActionError] = useState('')
  const [lastKnownWorktrees, setLastKnownWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  // The Workspace options this screen shares with the desktop; viewRef mirrors it for writes.
  const [view, setView] = useState<MobileViewState>(INITIAL_MOBILE_VIEW)
  const viewRef = useRef(view)
  // The desktop sidebar's Project grouping inputs; null for a desktop that serves none.
  const [servedProjectSections, setServedProjectSections] = useState<ServedProjectSections | null>(
    null
  )
  // The desktop's own repos from repo.list: an older desktop's rows group by these.
  const [desktopRepos, setDesktopRepos] = useState<readonly SectionRepo[]>([])
  // Host-label inputs for rows: repo → host, SSH/override labels, and the host's own platform.
  const [repoHostIdByRepoId, setRepoHostIdByRepoId] = useState<Map<string, ExecutionHostId>>(
    new Map()
  )
  const [hostLabelById, setHostLabelById] = useState<Map<ExecutionHostId, string>>(new Map())
  const [hostHealthById, setHostHealthById] = useState<Map<ExecutionHostId, ExecutionHostHealth>>(
    new Map()
  )
  const [hostPlatform, setHostPlatform] = useState<NodeJS.Platform | null>(null)
  // The desktop's servers and their rows, listed through the desktop (mobileRelay.hosts.*).
  const [serverWorkspaces, setServerWorkspaces] = useState<ServerWorkspaces>(NO_SERVER_WORKSPACES)
  // Why its own banner state: a tap on a server that needs an update says so until dismissed.
  const [serverNotice, setServerNotice] = useState<string | null>(null)
  const [showWorkspaceOptions, setShowWorkspaceOptions] = useState(false)
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [confirmRemoveHost, setConfirmRemoveHost] = useState(false)
  const [routeActionState, setRouteActionState] = useState(() =>
    createInitialHostRouteActionState(action)
  )
  const [sleptIds, setSleptIds] = useState<Set<string>>(new Set())
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  // Desktop's "Also show pinned worktrees in their original lists"; off by default.
  const [showPinnedInGroups, setShowPinnedInGroups] = useState(false)

  return {
    actionTarget,
    catalogError,
    clientRef,
    confirmDelete,
    confirmRemoveHost,
    actionError,
    error,
    fetchRepoMetadataInFlightRef,
    fetchRepoMetadataPendingRef,
    fetchWorktreesInFlightRef,
    hostLabelById,
    hostHealthById,
    hostName,
    hostPlatform,
    hostStoredDescriptor,
    lastKnownWorktrees,
    newWorktreeModalRef,
    newWorktreeModalVisibleRef,
    optimisticActiveWorktreeIdentity,
    pinnedIds,
    repoHostIdByRepoId,
    servedProjectSections,
    desktopRepos,
    repoMetadataFetchedAtRef,
    routeActionState,
    search,
    serverNotice,
    serverWorkspaces,
    setActionTarget,
    setCatalogError,
    setConfirmDelete,
    setConfirmRemoveHost,
    setActionError,
    setError,
    setHostLabelById,
    setHostHealthById,
    setHostName,
    setHostPlatform,
    setHostStoredDescriptor,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    setRepoHostIdByRepoId,
    setServedProjectSections,
    setDesktopRepos,
    setRouteActionState,
    setSearch,
    setServerNotice,
    setServerWorkspaces,
    setShowWorkspaceOptions,
    setShowPinnedInGroups,
    setShowSearch,
    setSleptIds,
    setWorktrees,
    setWorktreesLoaded,
    showWorkspaceOptions,
    showPinnedInGroups,
    showSearch,
    setView,
    view,
    viewRef,
    sleptIds,
    worktreeCatalogRef,
    worktrees,
    worktreesLoaded
  }
}

export type HostScreenState = ReturnType<typeof useHostScreenState>
