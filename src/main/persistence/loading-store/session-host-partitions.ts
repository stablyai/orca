import { orderTerminalRowsByTabGroups } from '../../../shared/workspace-layout/terminal-row-order'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../../runtime/mobile-session-terminal-persistence-retirement'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'
import { withoutRedundantGlobalFields } from '../../../shared/workspace-session-host-field-ownership'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { readTerminalScrollbackSnapshotSync } from '../../terminal-scrollback-snapshots'
import {
  hasTerminalScrollbackSnapshotSync,
  readTerminalScrollbackSnapshot,
  statTerminalScrollbackSnapshotSize
} from '../../terminal-scrollback-snapshot-nonblocking-reads'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from '../runtime-authored-workspace-session-fields'
import { dropClosedTerminalTabs } from '../closed-terminal-tab-write-fence'
import { findWorktreeIdForTab } from '../restoring-sessions/pane-identity-migration'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import {
  removeWorkspaceSessionOwner,
  workspaceSessionPartitionIdsForHost
} from '../restoring-sessions/session-owner-removal'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'
import {
  preserveMissingWorkspaceSessionTerminalBindings,
  sshTargetIdForWorkspaceSessionHost
} from './workspace-session-terminal-binding-replay'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
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

  readTerminalScrollbackSnapshot(ref: string): string | null {
    return readTerminalScrollbackSnapshotSync(
      ref,
      this[sessionHostPartitionOperationsContext].runtime.terminalScrollbackSnapshotStorage
    )
  }

  hasTerminalScrollbackSnapshot(ref: string): boolean {
    return hasTerminalScrollbackSnapshotSync(
      ref,
      this[sessionHostPartitionOperationsContext].runtime.terminalScrollbackSnapshotStorage
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
  session: WorkspaceSessionState
): void {
  const persisted =
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId?.[hostId]
  const prior = persisted ? withRequiredWorkspaceSessionMaps(persisted) : undefined
  // Empty host slices omit maps that retirement/rebase checks iterate.
  session = withRequiredWorkspaceSessionMaps(session)
  // Enforce at this shared boundary: quit staging bypasses per-caller normalization.
  session = dropClosedTerminalTabs(preserveRuntimeAuthoredWorkspaceSessionFields(session, prior))
  const { runtime } = owner[sessionHostPartitionOperationsContext]
  // Each host owns its topology fence; stale renderer snapshots rebase against that host only.
  session = keepRuntimePartitionRevisions(
    hostId,
    sanitizeWorkspaceSessionTerminalRetirements(
      session,
      runtimePartitionFencePrior(runtime, hostId, session, prior)
    ),
    prior
  )
  session = preserveMissingWorkspaceSessionTerminalBindings(
    session,
    prior,
    owner[sessionHostPartitionOperationsContext].bindingRecovery,
    {
      targetIdForWorktree: sshTargetIdForWorkspaceSessionHost(hostId),
      executionHostId: hostId
    }
  )
  // Strip redundant globals on every write so stale snapshots cannot reinject local-owned data.
  const pruned = withoutRedundantGlobalFields(
    pruneWorkspaceSessionBrowserHistory(
      pruneLocalTerminalScrollbackBuffers(
        session,
        owner[sessionHostPartitionOperationsContext].runtime.state.repos
      )
    ),
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSession
  )
  owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId = {
    ...owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId,
    [hostId]: withRequiredWorkspaceSessionMaps(orderTerminalRowsByTabGroups(pruned))
  }
  scheduleSave(
    owner[sessionHostPartitionOperationsContext].scheduling,
    ['workspaceSessionsByHostId'],
    hostId
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
