import { resolveHostId, sessionDomain } from '../../workspace-session-domains'
export { resolveHostId, sessionDomain } from '../../workspace-session-domains'
import { withRequiredWorkspaceSessionMaps } from './workspace-session-partitions'
export { withRequiredWorkspaceSessionMaps } from './workspace-session-partitions'
import { orderTerminalRowsByTabGroups } from '../../../../shared/workspace-layout/terminal-topology/terminal-row-order'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../../../runtime/terminal/surface/mobile-session-terminal-persistence-retirement'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
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

import {
  type WriteSchedulingOperations,
  scheduleSave,
  scheduleSessionFieldSave
} from '../profile-writing/write-scheduling'
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
  'state' | 'terminalScrollbackSnapshotStorage' | 'workspaceSessionFieldCapture'
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

  getWorkspaceSession(hostId?: string | null): WorkspaceSessionState {
    this[sessionHostPartitionOperationsContext].runtime.workspaceSessionFieldCapture.expose(
      sessionDomain(hostId)
    )
    return borrowWorkspaceSession(this, hostId)
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
    return findWorktreeIdForTab(borrowWorkspaceSession(this), tabId)
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
  const current = borrowWorkspaceSession(owner, resolved)
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
  return borrowWorkspaceSession(owner, hostId).tabsByWorktree?.[worktreeId] !== undefined
}

export function partitionHasOtherRepoWorktreeTabs(
  owner: SessionHostPartitionOperations,
  worktreeId: string,
  hostId: ExecutionHostId
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const tabsByWorktree = borrowWorkspaceSession(owner, hostId).tabsByWorktree ?? {}
  return Object.entries(tabsByWorktree).some(
    ([id, tabs]) =>
      id !== worktreeId && getRepoIdFromWorktreeId(id) === repoId && (tabs?.length ?? 0) > 0
  )
}

export function setHostWorkspaceSession(
  owner: SessionHostPartitionOperations,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  fields = false
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
  const schedule = fields ? scheduleSessionFieldSave : scheduleSave
  schedule(
    owner[sessionHostPartitionOperationsContext].scheduling,
    ['workspaceSessionsByHostId'],
    hostId
  )
}

type FullSessionReader = Pick<SessionHostPartitionOperations, 'getWorkspaceSession'>
type SessionReader = {
  getWorkspaceSession?(hostId?: string | null): Partial<WorkspaceSessionState> | undefined
}
function ownsSessionContext(owner: SessionReader): owner is SessionHostPartitionOperations {
  return sessionHostPartitionOperationsContext in owner
}

export function borrowWorkspaceSession(
  owner: FullSessionReader,
  hostId?: string | null
): WorkspaceSessionState
export function borrowWorkspaceSession(
  owner: { getWorkspaceSession(hostId: ExecutionHostId): WorkspaceSessionState | undefined },
  hostId: ExecutionHostId
): WorkspaceSessionState | undefined
export function borrowWorkspaceSession(
  owner: Partial<FullSessionReader> | null | undefined,
  hostId?: string | null
): WorkspaceSessionState | undefined
export function borrowWorkspaceSession(
  owner: SessionReader | null | undefined,
  hostId?: string | null
): Partial<WorkspaceSessionState> | undefined
export function borrowWorkspaceSession(
  owner: SessionReader | null | undefined,
  hostId?: string | null
): Partial<WorkspaceSessionState> | undefined {
  if (!owner || !ownsSessionContext(owner)) {
    return owner?.getWorkspaceSession?.(hostId)
  }
  const resolved = resolveHostId(hostId)
  const { state } = owner[sessionHostPartitionOperationsContext].runtime
  return (
    (resolved === LOCAL_EXECUTION_HOST_ID
      ? state.workspaceSession
      : state.workspaceSessionsByHostId?.[resolved]) ?? getDefaultWorkspaceSession()
  )
}

export function isOwnedWorkspaceSession(
  owner: SessionReader | null | undefined,
  hostId?: string | null
): boolean {
  return (
    !!owner &&
    ownsSessionContext(owner) &&
    owner[sessionHostPartitionOperationsContext].runtime.workspaceSessionFieldCapture.isOwned(
      sessionDomain(hostId)
    )
  )
}
