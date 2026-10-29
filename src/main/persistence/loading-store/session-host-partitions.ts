import { SessionUnitReader } from '../../../shared/session-unit-reader'
import { publishWorkspaceSessionSnapshot } from './workspace-session-snapshot-publication'
import { runSessionOperation } from './session-operation'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { readTerminalScrollbackSnapshotSync } from '../../terminal-scrollback-snapshots'
import {
  hasTerminalScrollbackSnapshotSync,
  readTerminalScrollbackSnapshot,
  statTerminalScrollbackSnapshotSize
} from '../../terminal-scrollback-snapshot-nonblocking-reads'
import type { SessionReferenceKind } from '../../../shared/session-unit-index'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import { workspaceSessionPartitionIdsForHost } from '../restoring-sessions/session-owner-removal'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import { noteRuntimeTopologyChange } from './runtime-partition-topology-fence'
import { publishSessionReplacement, sessionPublication } from './session-publication'

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

  getWorkspaceSessionGeneration(hostId?: string | null): string {
    return sessionPublication(this[sessionHostPartitionOperationsContext].runtime.state).generation(
      resolveHostId(hostId)
    )
  }

  getWorkspaceSessionReferences(kind: SessionReferenceKind, id: string, hostId?: string | null) {
    return sessionPublication(this[sessionHostPartitionOperationsContext].runtime.state)
      .partition(resolveHostId(hostId))
      .index.references(kind, id)
  }

  readWorkspaceSessionUnits(keys: readonly string[], hostId?: string | null) {
    const resolved = resolveHostId(hostId)
    const { root, index } = sessionPublication(
      this[sessionHostPartitionOperationsContext].runtime.state
    ).partition(resolved)
    const reader = new SessionUnitReader(root, index)
    const selected = reader.selectReferences(keys.map((id) => ({ kind: 'owner', id })))
    return {
      reader: reader.view('candidate'),
      selected,
      owners: [...reader.affectedOwners(selected)]
    }
  }

  removeWorkspaceSessionHost(hostId: ExecutionHostId): void {
    const runtime = this[sessionHostPartitionOperationsContext].runtime
    const partitions = runtime.state.workspaceSessionsByHostId
    if (hostId === LOCAL_EXECUTION_HOST_ID || partitions?.[hostId] === undefined) {
      return
    }
    publishSessionReplacement(runtime.state, hostId, undefined, 'fullReplacement')
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
    const { root, index } = sessionPublication(
      this[sessionHostPartitionOperationsContext].runtime.state
    ).partition(LOCAL_EXECUTION_HOST_ID)
    return new SessionUnitReader(root, index).terminalOwner(tabId, 'first')
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
  const advanceTerminalTopologyRevision = options.advanceTerminalTopologyRevision ?? true
  runSessionOperation(owner[sessionHostPartitionOperationsContext].runtime.state, resolved, {
    type: 'removeOwners',
    owners: [worktreeId],
    advanceRevision: advanceTerminalTopologyRevision
  })
  if (advanceTerminalTopologyRevision) {
    noteRuntimeTopologyChange(
      owner[sessionHostPartitionOperationsContext].runtime,
      resolved,
      worktreeId
    )
  }
  // Releasing session ownership may unblock metadata pruning.
  invalidateLocalWorktreeMetadataPruneInputs()
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
  const { root, index } = sessionPublication(
    owner[sessionHostPartitionOperationsContext].runtime.state
  ).partition(hostId)
  return index
    .references('repo', repoId)
    .some(
      ({ field, key }) =>
        field === 'tabsByWorktree' &&
        key !== worktreeId &&
        getRepoIdFromWorktreeId(key) === repoId &&
        (root.tabsByWorktree[key]?.length ?? 0) > 0
    )
}

export function setHostWorkspaceSession(
  owner: SessionHostPartitionOperations,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): void {
  const context = owner[sessionHostPartitionOperationsContext]
  const { root, index } = sessionPublication(context.runtime.state).partition(hostId)
  publishWorkspaceSessionSnapshot(
    context,
    hostId,
    SessionUnitReader.between(root, session, index),
    true
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
