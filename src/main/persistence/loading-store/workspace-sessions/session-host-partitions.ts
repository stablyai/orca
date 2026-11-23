import { orderTerminalRowsByTabGroups } from '../../../../shared/workspace-layout/terminal-topology/terminal-row-order'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../../../runtime/terminal/surface/mobile-session-terminal-persistence-retirement'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { pruneLocalTerminalScrollbackBuffers } from '../../../../shared/workspace-session/workspace-session-terminal-buffers'
import { pruneWorkspaceSessionBrowserHistory } from '../../../../shared/workspace-session/workspace-session-browser-history'
import { withoutRedundantGlobalFields } from '../../../../shared/workspace-session/workspace-session-host-field-ownership'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  readTerminalScrollbackSnapshot,
  statTerminalScrollbackSnapshotSize
} from '../../../pty/scrollback/terminal-scrollback-snapshot-nonblocking-reads'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from '../../runtime-authored-workspace-session-fields'
import { dropClosedTerminalTabs } from '../../closed-terminal-tab-write-fence'
import { findWorktreeIdForTab } from '../../restoring-sessions/pane-identity-migration'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../../workspaces/catalog/local-worktree-metadata-prune-gate'
import { isWslMoveWorkspaceSessionFrozen } from '../../moving-wsl-projects/quiescence/wsl-move-scope-guard'
import {
  removeWorkspaceSessionOwner,
  workspaceSessionPartitionIdsForHost
} from '../../restoring-sessions/session-owner-removal'

import type { StoreRuntimeState } from '../store-runtime-state'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'
import {
  pruneMissingLocalWorktreeSessionsForRepo as pruneMissingLocalWorktreeSessions,
  selectLocalWorktreeSessionOwnersForRepo,
  selectRemovableLocalWorktreeSessionOwners
} from '../../tracking-repos/missing-local-worktree-session-pruning'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../../tracking-repos/local-worktree-metadata-scan-expectation'

import { type WriteSchedulingOperations, scheduleSave } from '../profile-writing/write-scheduling'
import {
  membershipRewritesFor,
  withStoreRewrites,
  type WrittenWorkspaceScope
} from './workspace-session-write-listeners'
import {
  preserveMissingWorkspaceSessionTerminalBindings,
  sshTargetIdForWorkspaceSessionHost
} from './workspace-session-terminal-binding-replay'
import type { TerminalBindingRecoveryOperations } from '../terminal-bindings/terminal-binding-recovery'
import {
  keepRuntimePartitionRevisions,
  noteRuntimeTopologyChange,
  runtimePartitionFencePrior
} from './runtime-partition-topology-fence'

type SessionHostPartitionOperationsRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage'
>

const sessionHostPartitionOperationsContext = Symbol('SessionHostPartitionOperations')
type SessionHostPartitionOperationsContext = {
  runtime: SessionHostPartitionOperationsRuntime
  scheduling: WriteSchedulingOperations
  bindingRecovery: TerminalBindingRecoveryOperations
}

export class SessionHostPartitionOperations {
  readonly [sessionHostPartitionOperationsContext]: SessionHostPartitionOperationsContext

  constructor(
    runtime: SessionHostPartitionOperationsRuntime,
    scheduling: WriteSchedulingOperations,
    bindingRecovery: TerminalBindingRecoveryOperations
  ) {
    this[sessionHostPartitionOperationsContext] = {
      runtime,
      scheduling,
      bindingRecovery
    }
  }

  getWorkspaceSession(hostId?: string | null): PersistedState['workspaceSession'] {
    const resolved = resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      return (
        this[sessionHostPartitionOperationsContext].runtime.state.workspaceSession ??
        getDefaultWorkspaceSession()
      )
    }
    return (
      this[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId?.[
        resolved
      ] ?? getDefaultWorkspaceSession()
    )
  }

  /** Whether a partition is saved for this host (local always is), without listing them all. */
  hasWorkspaceSessionHost(hostId?: string | null): boolean {
    return hasPersistedWorkspaceSession(this, resolveHostId(hostId))
  }

  getWorkspaceSessionHostIds(): ExecutionHostId[] {
    const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
    for (const key of Object.keys(
      this[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId ?? {}
    )) {
      const hostId = normalizeExecutionHostId(key)
      if (hostId) {
        hostIds.add(hostId)
      }
    }
    return [...hostIds]
  }

  removeWorkspaceSessionHost(hostId: ExecutionHostId): void {
    const runtime = this[sessionHostPartitionOperationsContext].runtime
    const partitions = runtime.state.workspaceSessionsByHostId
    if (hostId === LOCAL_EXECUTION_HOST_ID || partitions?.[hostId] === undefined) {
      return
    }
    const { [hostId]: _removed, ...remaining } = partitions
    runtime.state.workspaceSessionsByHostId = remaining
    invalidateLocalWorktreeMetadataPruneInputs()
    scheduleSave(
      this[sessionHostPartitionOperationsContext].scheduling,
      ['workspaceSessionsByHostId'],
      hostId
    )
  }

  readTerminalScrollbackSnapshotAsync(ref: string): Promise<string | null> {
    return readTerminalScrollbackSnapshot(
      ref,
      this[sessionHostPartitionOperationsContext].runtime.terminalScrollbackSnapshotStorage
    )
  }

  statTerminalScrollbackSnapshotSize(ref: string): Promise<number | null> {
    return statTerminalScrollbackSnapshotSize(
      ref,
      this[sessionHostPartitionOperationsContext].runtime.terminalScrollbackSnapshotStorage
    )
  }

  getWorktreeIdForTab(tabId: string): string | undefined {
    return findWorktreeIdForTab(this.getWorkspaceSession(), tabId)
  }

  removeWorkspaceSessionStateForWorktree(
    target: HostWorktreeTarget,
    options: { advanceTerminalTopologyRevision?: boolean } = {}
  ): void {
    for (const resolved of workspaceSessionPartitionIdsForHost(target.hostId)) {
      removeWorkspaceSessionOwnerInPartition(this, target.id, resolved, options)
    }
  }

  /** Candidates for the post-scan cleanup, filtered before any path probe. */
  selectRemovableLocalWorktreeSessionOwnersForRepo(repoId: string): string[] {
    const { state } = this[sessionHostPartitionOperationsContext].runtime
    return selectRemovableLocalWorktreeSessionOwners(
      state,
      repoId,
      selectLocalWorktreeSessionOwnersForRepo(state.workspaceSession, repoId)
    )
  }

  /** Drops local saved session state of worktrees a scan no longer lists and whose folders are gone. */
  pruneMissingLocalWorktreeSessionsForRepo(
    scan: NativeLocalWorktreeMetadataScanExpectation,
    missingWorktreeIds: readonly string[]
  ): string[] {
    const context = this[sessionHostPartitionOperationsContext]
    const removed = pruneMissingLocalWorktreeSessions(
      context.runtime.state,
      scan,
      missingWorktreeIds
    )
    if (removed.length > 0) {
      // Releasing session ownership unblocks metadata pruning for the same worktrees.
      invalidateLocalWorktreeMetadataPruneInputs()
      scheduleSave(context.scheduling, [WORKSPACE_SESSION_DOMAINS[0]], LOCAL_EXECUTION_HOST_ID)
    }
    return removed
  }
}

export function resolveHostId(hostId?: string | null): ExecutionHostId {
  return normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
}

export function hasPersistedWorkspaceSession(
  owner: SessionHostPartitionOperations,
  hostId: ExecutionHostId
): boolean {
  return (
    hostId === LOCAL_EXECUTION_HOST_ID ||
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId?.[
      hostId
    ] !== undefined
  )
}

export function removeWorkspaceSessionOwnerInPartition(
  owner: SessionHostPartitionOperations,
  worktreeId: string,
  resolved: ExecutionHostId,
  options: { advanceTerminalTopologyRevision?: boolean }
): void {
  if (!hasPersistedWorkspaceSession(owner, resolved)) {
    return
  }
  // A paused WSL move keeps its local rows for a downgrade.
  if (resolved === LOCAL_EXECUTION_HOST_ID && isWslMoveWorkspaceSessionFrozen(worktreeId)) {
    return
  }
  const current = owner.getWorkspaceSession(resolved)
  const advanceTerminalTopologyRevision = options.advanceTerminalTopologyRevision ?? true
  const session = removeWorkspaceSessionOwner(current, worktreeId, {
    advanceTerminalTopologyRevision
  })
  if (advanceTerminalTopologyRevision) {
    noteRuntimeTopologyChange(
      owner[sessionHostPartitionOperationsContext].runtime,
      resolved,
      worktreeId
    )
  }
  if (!session) {
    return
  }
  // Releasing session ownership may unblock metadata pruning; no other signal covers this write.
  invalidateLocalWorktreeMetadataPruneInputs()
  if (resolved === LOCAL_EXECUTION_HOST_ID) {
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSession = session
  } else {
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId = {
      ...owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId,
      [resolved]: session
    }
  }
  scheduleSave(
    owner[sessionHostPartitionOperationsContext].scheduling,
    resolved === LOCAL_EXECUTION_HOST_ID ? ['workspaceSession'] : ['workspaceSessionsByHostId'],
    resolved
  )
}

export function partitionOwnsWorktreeTabs(
  owner: SessionHostPartitionOperations,
  worktreeId: string,
  hostId: ExecutionHostId
): boolean {
  return owner.getWorkspaceSession(hostId).tabsByWorktree?.[worktreeId] !== undefined
}

export function partitionHasOtherRepoWorktreeTabs(
  owner: SessionHostPartitionOperations,
  worktreeId: string,
  hostId: ExecutionHostId
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const tabsByWorktree = owner.getWorkspaceSession(hostId).tabsByWorktree ?? {}
  return Object.entries(tabsByWorktree).some(
    ([id, tabs]) =>
      id !== worktreeId && getRepoIdFromWorktreeId(id) === repoId && (tabs?.length ?? 0) > 0
  )
}

export function setHostWorkspaceSession(
  owner: SessionHostPartitionOperations,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  written?: WrittenWorkspaceScope
): void {
  const { runtime, bindingRecovery, scheduling } = owner[sessionHostPartitionOperationsContext]
  const persisted = runtime.state.workspaceSessionsByHostId?.[hostId]
  const prior = persisted ? withRequiredWorkspaceSessionMaps(persisted) : undefined
  const rewrites = membershipRewritesFor(written)
  // Empty host slices omit maps that retirement/rebase checks iterate.
  session = withRequiredWorkspaceSessionMaps(session)
  // Enforce at this shared boundary: quit staging bypasses per-caller normalization.
  session = dropClosedTerminalTabs(
    preserveRuntimeAuthoredWorkspaceSessionFields(session, prior),
    undefined,
    rewrites?.worktreeIds
  )
  // Each host owns its topology fence; stale renderer snapshots rebase against that host only.
  session = keepRuntimePartitionRevisions(
    hostId,
    sanitizeWorkspaceSessionTerminalRetirements(
      session,
      runtimePartitionFencePrior(runtime, hostId, session, prior),
      rewrites
    ),
    prior
  )
  session = preserveMissingWorkspaceSessionTerminalBindings(session, prior, bindingRecovery, {
    targetIdForWorktree: sshTargetIdForWorkspaceSessionHost(hostId),
    executionHostId: hostId
  })
  const scrollbackKept = pruneLocalTerminalScrollbackBuffers(session, runtime.state.repos)
  // Strip redundant globals on every write so stale snapshots cannot reinject local-owned data.
  const pruned = withoutRedundantGlobalFields(
    pruneWorkspaceSessionBrowserHistory(scrollbackKept),
    runtime.state.workspaceSession
  )
  runtime.state.workspaceSessionsByHostId = {
    ...runtime.state.workspaceSessionsByHostId,
    [hostId]: withRequiredWorkspaceSessionMaps(
      orderTerminalRowsByTabGroups(pruned, rewrites?.worktreeIds)
    )
  }
  scheduleSave(
    scheduling,
    ['workspaceSessionsByHostId'],
    hostId,
    // A prune can strip scrollback from workspaces the caller never named.
    scrollbackKept === session ? withStoreRewrites(written, rewrites) : undefined
  )
}

/** Restore required maps omitted by the renderer's sparse host split. */
export function withRequiredWorkspaceSessionMaps(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  return {
    ...session,
    tabsByWorktree: session.tabsByWorktree ?? {},
    terminalLayoutsByTabId: session.terminalLayoutsByTabId ?? {}
  }
}
