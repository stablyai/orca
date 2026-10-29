import type { RuntimeWorkspaceCatalog } from './workspace-catalog'
import type { OrcaRuntimeWithListManagedWorktrees } from './managed-workspace-operations'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../session-graph/session-graph-authority'
import type { OrcaRuntimeWithBindPtyIncarnationHandle } from '../terminal/identity/terminal-handle-bindings'
import type { OrcaRuntimeWithInvalidateAllHandlesForPty } from '../terminal/lifecycle/pty-handle-invalidation'
import { OrcaRuntimeWithPersistHeadlessTerminalTitle } from './workspace-file-session-targets'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { resolveWorktreeHostRouting } from '../worktree-launch-host-repo'
import { findRuntimeWorkspaceFileOwner } from '../../../shared/runtime-workspace-file-owner'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import type { PtyIncarnationId } from '../../../shared/pty-incarnation'
import { forgetPtySurface } from '../pty-recorded-surface-topology'

export abstract class OrcaRuntimeWithResolveKnownWorkspaceFileTarget extends OrcaRuntimeWithPersistHeadlessTerminalTitle {
  protected abstract listResolvedWorktrees(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktrees']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktrees']>
  protected abstract buildRuntimeVisibilitySourceMatchersByRepoId(
    ...args: Parameters<
      OrcaRuntimeWithListManagedWorktrees['buildRuntimeVisibilitySourceMatchersByRepoId']
    >
  ): ReturnType<OrcaRuntimeWithListManagedWorktrees['buildRuntimeVisibilitySourceMatchersByRepoId']>
  protected abstract isRuntimeWorktreeVisible(
    ...args: Parameters<OrcaRuntimeWithListManagedWorktrees['isRuntimeWorktreeVisible']>
  ): ReturnType<OrcaRuntimeWithListManagedWorktrees['isRuntimeWorktreeVisible']>
  protected abstract resolveFolderWorkspaceConnectionId(
    ...args: Parameters<
      OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceConnectionId']
    >
  ): ReturnType<
    OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceConnectionId']
  >
  protected abstract invalidatePtyIncarnationHandle(
    ...args: Parameters<OrcaRuntimeWithBindPtyIncarnationHandle['invalidatePtyIncarnationHandle']>
  ): ReturnType<OrcaRuntimeWithBindPtyIncarnationHandle['invalidatePtyIncarnationHandle']>
  protected abstract invalidateAllHandlesForPty(
    ...args: Parameters<OrcaRuntimeWithInvalidateAllHandlesForPty['invalidateAllHandlesForPty']>
  ): ReturnType<OrcaRuntimeWithInvalidateAllHandlesForPty['invalidateAllHandlesForPty']>
  protected abstract isTerminalHandleAdoptionBlocked(
    ...args: Parameters<
      OrcaRuntimeWithInvalidateAllHandlesForPty['isTerminalHandleAdoptionBlocked']
    >
  ): ReturnType<OrcaRuntimeWithInvalidateAllHandlesForPty['isTerminalHandleAdoptionBlocked']>
  protected abstract replaceSyntheticTerminalHandlesForRestoredPty(
    ...args: Parameters<
      OrcaRuntimeWithInvalidateAllHandlesForPty['replaceSyntheticTerminalHandlesForRestoredPty']
    >
  ): ReturnType<
    OrcaRuntimeWithInvalidateAllHandlesForPty['replaceSyntheticTerminalHandlesForRestoredPty']
  >

  protected async resolveKnownWorkspaceFileTarget(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
    relativePath: string
  } | null> {
    const targets = new Map<
      string,
      { worktree: ResolvedWorktree; executionHostId: ExecutionHostId }
    >()
    const repos = this.store?.getRepos() ?? []
    const resolvedWorktrees = await this.listResolvedWorktrees()
    const visibilitySourceMatchersByRepoId =
      this.buildRuntimeVisibilitySourceMatchersByRepoId(resolvedWorktrees)
    for (const worktree of resolvedWorktrees) {
      if (
        !this.isRuntimeWorktreeVisible(
          worktree,
          visibilitySourceMatchersByRepoId.get(worktree.repoId)
        )
      ) {
        continue
      }
      // Host-blind repo ids can misroute SSH paths; drop candidates with no unambiguous filesystem owner.
      const routing = resolveWorktreeHostRouting(repos, worktree)
      if (routing.kind === 'ambiguous') {
        continue
      }
      const target = {
        worktree,
        executionHostId: routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
      }
      targets.set(`${target.executionHostId}\0${worktree.id}`, target)
    }
    for (const folderWorkspace of this.store?.getFolderWorkspaces?.() ?? []) {
      try {
        const candidateConnectionId = this.resolveFolderWorkspaceConnectionId(folderWorkspace)
        const worktree = this.folderWorkspaceToResolvedWorktree(folderWorkspace)
        const target = {
          worktree,
          executionHostId: getConnectionExecutionHostId(candidateConnectionId)
        }
        targets.set(`${target.executionHostId}\0${worktree.id}`, target)
      } catch {
        // An ambiguous folder workspace has no single filesystem authority.
      }
    }

    const owner = findRuntimeWorkspaceFileOwner(
      [...targets.values()].map((target) => ({
        workspaceId: target.worktree.id,
        rootPath: target.worktree.path,
        executionHostId: target.executionHostId
      })),
      absolutePath,
      executionHostId
    )
    if (!owner) {
      return null
    }
    const target = targets.get(`${owner.executionHostId}\0${owner.workspaceId}`)
    return target ? { ...target, relativePath: owner.relativePath } : null
  }

  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void,
    clientNavigationId?: string
  ): () => void {
    // Drain coalesced notifications before subscribing: the initial snapshot already includes them.
    this.mobileSessionTabsNotifyCoalescer.flushAll()
    const subscription = { listener, clientNavigationId }
    this.mobileSessionTabListeners.add(subscription)
    return () => {
      // Flush before removal so this listener receives the latest settled state.
      this.mobileSessionTabsNotifyCoalescer.flushAll()
      this.mobileSessionTabListeners.delete(subscription)
      if (this.mobileSessionTabListeners.size === 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.cancelPending()
      }
    }
  }

  forgetClientNavigationState(clientNavigationId: string): void {
    this.clientSessionTabSelections.forgetClient(clientNavigationId)
  }

  // Allocate before spawn so ORCA_TERMINAL_HANDLE lets agents self-identify; lazy RPC allocation reuses it.
  preAllocateHandleForPty(ptyId: string): string {
    const existing = this.handleByPtyId.get(ptyId)
    if (existing) {
      return existing
    }
    const handle = this.createPreAllocatedTerminalHandle()
    this.handleByPtyId.set(ptyId, handle)
    return handle
  }

  createPreAllocatedTerminalHandle(): string {
    return `term_${randomUUID()}`
  }

  protected rememberPtyHandleReplacementFence(
    ptyId: string,
    incarnationId: PtyIncarnationId,
    staleHandles: Iterable<string>,
    pendingRegistration: boolean
  ): void {
    const previous = this.pendingPtyHandleReplacementFences.get(ptyId)
    const merged = new Set(previous?.staleHandles)
    for (const handle of staleHandles) {
      merged.add(handle)
    }
    // Bound aliases in case a malformed provider emits an unbounded stream.
    while (merged.size > 16) {
      const oldest = merged.values().next().value
      if (typeof oldest !== 'string') {
        break
      }
      merged.delete(oldest)
    }
    this.pendingPtyHandleReplacementFences.set(ptyId, {
      incarnationId,
      staleHandles: merged,
      pendingRegistration
    })
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    if (this.pendingPtyHandleReplacementFences.get(ptyId)?.staleHandles.has(handle)) {
      // The provider can replay the old env handle after announcing a new
      // incarnation. Never let that predecessor alias be reintroduced.
      return
    }
    const retained = this.handleByPtyIncarnation.get(ptyId)
    if (retained?.handle === handle) {
      this.handleByPtyIncarnation.delete(ptyId)
    } else {
      this.invalidatePtyIncarnationHandle(ptyId)
    }
    this.handleByPtyId.set(ptyId, handle)
    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.adoptPreAllocatedHandle(leaf)
    }
  }

  protected adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    const trimmed = handle?.trim()
    if (!trimmed || !trimmed.startsWith('term_')) {
      return
    }
    const pty = this.ptysById.get(ptyId)
    const changedIncarnation = Boolean(
      incarnationId && pty?.incarnationId && incarnationId !== pty.incarnationId
    )
    if (changedIncarnation) {
      const priorHandle = this.handleByPtyId.get(ptyId)
      this.invalidateAllHandlesForPty(ptyId)
      forgetPtySurface(pty!)
      // Reusing an exported handle would make stale client metadata name the replacement process.
      if (priorHandle === trimmed) {
        return
      }
    }
    if (this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)) {
      if (
        !options.exactRestoredSurface ||
        !this.replaceSyntheticTerminalHandlesForRestoredPty(ptyId, trimmed) ||
        this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)
      ) {
        return
      }
    }
    // After runtime restart, surviving PTYs still carry their original exported handle.
    this.registerPreAllocatedHandleForPty(ptyId, trimmed)
  }
}
