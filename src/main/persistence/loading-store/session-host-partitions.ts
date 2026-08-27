import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../../runtime/mobile-session-terminal-persistence-retirement'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { readTerminalScrollbackSnapshotSync } from '../../terminal-scrollback-snapshots'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from '../runtime-authored-workspace-session-fields'
import { findWorktreeIdForTab } from '../restoring-sessions/pane-identity-migration'
import {
  removeWorkspaceSessionOwner,
  workspaceSessionPartitionIdsForHost
} from '../restoring-sessions/session-owner-removal'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type SessionHostPartitionOperationsRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage'
>

const sessionHostPartitionOperationsContext = Symbol('SessionHostPartitionOperations')
type SessionHostPartitionOperationsContext = {
  runtime: SessionHostPartitionOperationsRuntime
  scheduling: WriteSchedulingOperations
}

export class SessionHostPartitionOperations {
  readonly [sessionHostPartitionOperationsContext]: SessionHostPartitionOperationsContext

  constructor(
    runtime: SessionHostPartitionOperationsRuntime,
    scheduling: WriteSchedulingOperations
  ) {
    this[sessionHostPartitionOperationsContext] = { runtime, scheduling }
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

  readTerminalScrollbackSnapshot(ref: string): string | null {
    return readTerminalScrollbackSnapshotSync(
      ref,
      this[sessionHostPartitionOperationsContext].runtime.terminalScrollbackSnapshotStorage
    )
  }

  getWorktreeIdForTab(tabId: string): string | undefined {
    return findWorktreeIdForTab(this.getWorkspaceSession(), tabId)
  }

  removeWorkspaceSessionStateForWorktree(
    worktreeId: string,
    hostId?: ExecutionHostId | null,
    options: { advanceTerminalTopologyRevision?: boolean } = {}
  ): void {
    for (const resolved of workspaceSessionPartitionIdsForHost(hostId)) {
      removeWorkspaceSessionOwnerInPartition(this, worktreeId, resolved, options)
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
  const current = owner.getWorkspaceSession(resolved)
  const session = removeWorkspaceSessionOwner(current, worktreeId, {
    advanceTerminalTopologyRevision: options.advanceTerminalTopologyRevision ?? true
  })
  if (!session) {
    return
  }
  if (resolved === LOCAL_EXECUTION_HOST_ID) {
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSession = session
  } else {
    // Host scoping matters because identical repo/path ids may exist on two servers.
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId = {
      ...owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId,
      [resolved]: session
    }
  }
  scheduleSave(owner[sessionHostPartitionOperationsContext].scheduling)
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
  // Why here and not at the callers: the before-unload stage path writes the renderer's payload
  // straight through, so a per-caller guard leaves the quit write erasing runtime-authored rows.
  session = preserveRuntimeAuthoredWorkspaceSessionFields(
    session,
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId?.[hostId]
  )
  // Why: each partition owns its topology fence; renderer writes omit it and must rebase locally.
  session = sanitizeWorkspaceSessionTerminalRetirements(
    session,
    owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId?.[hostId]
  )
  const pruned = pruneWorkspaceSessionBrowserHistory(
    pruneLocalTerminalScrollbackBuffers(
      session,
      owner[sessionHostPartitionOperationsContext].runtime.state.repos
    )
  )
  owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId = {
    ...owner[sessionHostPartitionOperationsContext].runtime.state.workspaceSessionsByHostId,
    [hostId]: pruned
  }
  scheduleSave(owner[sessionHostPartitionOperationsContext].scheduling)
}

export function installSessionHostPartitionOperationsContext(
  target: object,
  source: SessionHostPartitionOperations
): void {
  Object.defineProperty(target, sessionHostPartitionOperationsContext, {
    value: source[sessionHostPartitionOperationsContext]
  })
}
