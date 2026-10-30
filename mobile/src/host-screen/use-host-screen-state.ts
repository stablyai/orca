import { useCallback, useRef, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host-health'
import { getCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import { WorktreeCatalogSnapshotClient } from '../worktree/worktree-catalog-snapshot-client'
import { INITIAL_MOBILE_VIEW, type MobileViewState } from '../worktree/workspace-view-settings'
import type { Worktree } from '../worktree/workspace-list-sections'
import type { ServedProjectSections } from '../worktree/project-sections-operations'
import type { SectionRepo } from '../worktree/workspace-list-types'
import { NO_SERVER_WORKSPACES, type ServerWorkspaces } from '../worktree/server-workspaces'
import type { ProjectGroup } from '../../../src/shared/project-group-types'

export function useHostScreenState(hostId: string | undefined) {
  const [initialCache] = useState(() =>
    hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
  )
  const clientRef = useRef<RpcClient | null>(null)
  const fetchWorktreesInFlightRef = useRef(false)
  // Use a ref: React may discard memoized values and silently reset the owned snapshot token.
  const worktreeCatalogRef = useRef(new WorktreeCatalogSnapshotClient())
  const fetchRepoMetadataInFlightRef = useRef(new WeakSet<RpcClient>())
  const fetchRepoMetadataPendingRef = useRef(new WeakSet<RpcClient>())
  const repoMetadataFetchedAtRef = useRef(0)
  const newWorktreeModalVisibleRef = useRef(false)
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [worktreesLoaded, setWorktreesLoaded] = useState(initialCache != null)
  // Retain catalog failure codes so broken hosts do not render as empty; clear on success (STA-3123).
  const [catalogError, setCatalogError] = useState<string | null>(null)
  // Highlight local navigation immediately instead of waiting for the next poll.
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
  // Keep action errors separate from identity errors so a failed action cannot replace the list and its recovery controls.
  const [actionError, setActionError] = useState('')
  const [lastKnownWorktrees, setLastKnownWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [view, setView] = useState<MobileViewState>(INITIAL_MOBILE_VIEW)
  const viewRef = useRef(view)
  const [servedProjectSections, setServedProjectSections] = useState<ServedProjectSections | null>(
    null
  )
  const [desktopRepos, setDesktopRepos] = useState<readonly SectionRepo[]>([])
  const [repoHostIdByRepoId, setRepoHostIdByRepoId] = useState<Map<string, ExecutionHostId>>(
    new Map()
  )
  const [hostLabelById, setHostLabelById] = useState<Map<ExecutionHostId, string>>(new Map())
  const [hostHealthById, setHostHealthById] = useState<Map<ExecutionHostId, ExecutionHostHealth>>(
    new Map()
  )
  const [hostPlatform, setHostPlatform] = useState<NodeJS.Platform | null>(null)
  const [serverWorkspaces, setServerWorkspaces] = useState<ServerWorkspaces>(NO_SERVER_WORKSPACES)
  const [serverNotice, setServerNotice] = useState<string | null>(null)
  const [showWorkspaceOptions, setShowWorkspaceOptions] = useState(false)
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [confirmRemoveHost, setConfirmRemoveHost] = useState(false)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  // Why the ref too: the catalog poll reads it from callbacks that outlive this render.
  const setNewWorktreeVisible = useCallback((visible: boolean) => {
    newWorktreeModalVisibleRef.current = visible
    setShowNewWorktree(visible)
  }, [])
  const [sleptIds, setSleptIds] = useState<Set<string>>(new Set())
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const [showPinnedInGroups, setShowPinnedInGroups] = useState(false)
  const [hostProjectGroups, setHostProjectGroups] = useState<readonly ProjectGroup[]>([])

  return {
    actionTarget,
    catalogError,
    clientRef,
    confirmDelete,
    confirmRemoveHost,
    hostProjectGroups,
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
    newWorktreeModalVisibleRef,
    optimisticActiveWorktreeIdentity,
    pinnedIds,
    repoHostIdByRepoId,
    servedProjectSections,
    desktopRepos,
    repoMetadataFetchedAtRef,
    search,
    serverNotice,
    serverWorkspaces,
    setActionTarget,
    setCatalogError,
    setConfirmDelete,
    setConfirmRemoveHost,
    setHostProjectGroups,
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
    setNewWorktreeVisible,
    setSearch,
    setServerNotice,
    setServerWorkspaces,
    setShowWorkspaceOptions,
    setShowPinnedInGroups,
    setShowSearch,
    setSleptIds,
    setWorktrees,
    setWorktreesLoaded,
    showNewWorktree,
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
