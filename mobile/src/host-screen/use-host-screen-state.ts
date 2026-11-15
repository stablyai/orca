import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ExecutionHostHealth } from '../../../src/shared/execution-host/execution-host-health'
import { storedHostDescriptor, type HostStoredDescriptor } from './identity/host-stored-identity'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { HostProfile } from '../host-catalog/host-profile'
import {
  INITIAL_MOBILE_VIEW,
  type MobileViewState
} from '../worktree/workspace-list/workspace-view-settings'

import type { ServedProjectSections } from '../../../src/shared/project-section-catalog-schema'
import type { SectionRepo, Worktree } from '../worktree/workspace-list/workspace-list-types'
import {
  NO_SERVER_WORKSPACES,
  type ServerWorkspaces
} from '../worktree/execution-hosts/server-workspaces'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { cachedHostWorktrees } from './catalog/host-list-queries'
import { cachedHostView, useHostViewMemory } from './view-settings/host-view-memory'

export function useHostScreenState(
  hostId: string | undefined,
  storedHost: HostProfile | null = null
) {
  const queryClient = useQueryClient()
  // The rows this world last read for the host, so a reopened list paints them in its first frame.
  const [initialCache] = useState(() => cachedHostWorktrees(queryClient, hostId))
  const clientRef = useRef<RpcClient | null>(null)
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [worktreesLoaded, setWorktreesLoaded] = useState(initialCache != null)
  // Retain catalog failure codes so broken hosts do not render as empty; clear on success (STA-3123).
  const [catalogError, setCatalogError] = useState<string | null>(null)
  // Highlight local navigation immediately instead of waiting for the next poll.
  const [optimisticActiveWorktreeIdentity, setOptimisticActiveWorktreeIdentity] = useState<
    string | null
  >(null)
  const [seedHost] = useState(storedHost)
  const [hostName, setHostName] = useState(seedHost?.name ?? '')
  // The stored name identity, loaded with the name so the header can label an offline host.
  const [hostStoredDescriptor, setHostStoredDescriptor] = useState<HostStoredDescriptor | null>(
    seedHost ? storedHostDescriptor(seedHost) : null
  )
  const [error, setError] = useState('')
  // Keep action errors separate from identity errors so a failed action cannot replace the list and its recovery controls.
  const [actionError, setActionError] = useState('')
  const [lastKnownWorktrees, setLastKnownWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [search, setSearch] = useState('')
  const [view, setView] = useState<MobileViewState>(
    () => cachedHostView(queryClient, hostId) ?? INITIAL_MOBILE_VIEW
  )
  const viewRef = useRef(view)
  const rememberView = useHostViewMemory(hostId)
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
  const setNewWorktreeVisible = useCallback((visible: boolean) => setShowNewWorktree(visible), [])
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
    hostLabelById,
    hostHealthById,
    hostName,
    hostPlatform,
    hostStoredDescriptor,
    lastKnownWorktrees,
    optimisticActiveWorktreeIdentity,
    pinnedIds,
    repoHostIdByRepoId,
    servedProjectSections,
    desktopRepos,
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
    setSleptIds,
    setWorktrees,
    setWorktreesLoaded,
    showNewWorktree,
    showWorkspaceOptions,
    showPinnedInGroups,
    setView,
    rememberView,
    view,
    viewRef,
    sleptIds,
    worktrees,
    worktreesLoaded
  }
}

export type HostScreenState = ReturnType<typeof useHostScreenState>
