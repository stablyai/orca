import type { PersistedState } from '../../../../shared/persisted-state-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { pruneWorkspaceSessionBrowserHistory } from '../../../../shared/workspace-session/workspace-session-browser-history'

import { workspaceSessionPatchNeedsFullNormalization } from './terminal-session-cleanup'

import { setLocalWorkspaceSession } from './workspace-session-snapshot-publication'
import type { TerminalBindingRecoveryOperations } from '../terminal-bindings/terminal-binding-recovery'
import {
  sessionSnapshotOperationsContext,
  type SessionSnapshotOperationsContext,
  type SessionSnapshotOperationsRuntime
} from './session-snapshot-operations-context'

import {
  type SessionHostPartitionOperations,
  resolveHostId,
  setHostWorkspaceSession,
  withRequiredWorkspaceSessionMaps,
  borrowWorkspaceSession,
  sessionDomain
} from './session-host-partitions'
import { dropClosedTerminalTabs } from '../../closed-terminal-tab-write-fence'
import { keepWslMoveFrozenSessionsForStore } from '../../moving-wsl-projects/terminal-state/wsl-move-session-freeze'
import {
  type WriteSchedulingOperations,
  scheduleSave,
  scheduleSessionFieldSave
} from '../profile-writing/write-scheduling'
import { orderTerminalRowsByTabGroups } from '../../../../shared/workspace-layout/terminal-topology/terminal-row-order'

export class SessionSnapshotOperations {
  readonly [sessionSnapshotOperationsContext]: SessionSnapshotOperationsContext

  constructor(
    runtime: SessionSnapshotOperationsRuntime,
    sessions: SessionHostPartitionOperations,
    bindingRecovery: TerminalBindingRecoveryOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[sessionSnapshotOperationsContext] = { runtime, sessions, bindingRecovery, scheduling }
  }

  setWorkspaceSession(session: PersistedState['workspaceSession'], hostId?: string | null): void {
    this[sessionSnapshotOperationsContext].runtime.workspaceSessionFieldCapture.expose(
      sessionDomain(hostId)
    )
    setSession(this, session, hostId)
  }

  stageWorkspaceSessionBeforeUnload(
    session: PersistedState['workspaceSession'],
    hostId?: string | null
  ): void {
    this[sessionSnapshotOperationsContext].runtime.workspaceSessionFieldCapture.expose(
      sessionDomain(hostId)
    )
    const resolved = resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      assertSnapshotAdmission(this)
      setLocalWorkspaceSession(this, session, true)
    } else {
      setHostWorkspaceSession(this[sessionSnapshotOperationsContext].sessions, resolved, session)
    }
  }

  patchWorkspaceSession(patch: WorkspaceSessionPatch, hostId?: string | null): void {
    this[sessionSnapshotOperationsContext].runtime.workspaceSessionFieldCapture.expose(
      sessionDomain(hostId)
    )
    patchSession(this, patch, hostId)
  }
}

function setSession(
  owner: SessionSnapshotOperations,
  session: WorkspaceSessionState,
  hostId?: string | null,
  fields = false
): void {
  const resolved = resolveHostId(hostId)
  const { runtime, sessions } = owner[sessionSnapshotOperationsContext]
  if (runtime.durableMutationPhase === 'rollback') {
    assertSnapshotAdmission(owner, true)
    publishSession(
      owner,
      resolved === LOCAL_EXECUTION_HOST_ID
        ? keepWslMoveFrozenSessionsForStore(session, runtime.state.workspaceSession)
        : session,
      resolved
    )
  } else if (resolved === LOCAL_EXECUTION_HOST_ID) {
    assertSnapshotAdmission(owner, true)
    setLocalWorkspaceSession(owner, session, false, fields)
  } else {
    setHostWorkspaceSession(sessions, resolved, session, fields)
  }
}

function patchSession(
  owner: SessionSnapshotOperations,
  patch: WorkspaceSessionPatch,
  hostId?: string | null,
  fields = false
): void {
  const resolved = resolveHostId(hostId)
  const { runtime, sessions } = owner[sessionSnapshotOperationsContext]
  let next: WorkspaceSessionState = { ...borrowWorkspaceSession(sessions, resolved), ...patch }
  if (workspaceSessionPatchNeedsFullNormalization(patch)) {
    setSession(owner, next, resolved, fields)
    return
  }
  if (Object.hasOwn(patch, 'browserUrlHistory')) {
    next = pruneWorkspaceSessionBrowserHistory(next)
  }
  if (Object.hasOwn(patch, 'unifiedTabs')) {
    next = dropClosedTerminalTabs(next)
  }
  if (resolved === LOCAL_EXECUTION_HOST_ID) {
    next = keepWslMoveFrozenSessionsForStore(next, runtime.state.workspaceSession)
  }
  publishSession(owner, next, resolved, fields)
}

function publishSession(
  owner: SessionSnapshotOperations,
  session: WorkspaceSessionState,
  hostId: ExecutionHostId,
  fields = false
): void {
  session = orderTerminalRowsByTabGroups(session)
  const { runtime, scheduling } = owner[sessionSnapshotOperationsContext]
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    runtime.state.workspaceSession = session
  } else {
    runtime.state.workspaceSessionsByHostId = {
      ...runtime.state.workspaceSessionsByHostId,
      [hostId]: withRequiredWorkspaceSessionMaps(session)
    }
  }
  const schedule = fields ? scheduleSessionFieldSave : scheduleSave
  schedule(scheduling, [sessionDomain(hostId)], hostId)
}

function assertSnapshotAdmission(
  owner: SessionSnapshotOperations,
  allowAdmittedMutation = false
): void {
  const { runtime } = owner[sessionSnapshotOperationsContext]
  if (
    runtime.writesFrozen ||
    ((runtime.profileMaintenancePending || runtime.quitFlushStarted) &&
      !(allowAdmittedMutation && runtime.durableMutationPhase !== null))
  ) {
    throw new Error('Profile maintenance or finalization is blocking new terminal snapshot work')
  }
}

/** Existing Electron IPC has already detached the sender's graph. No wire hint grants ownership. */
export function setDetachedWorkspaceSession(
  owner: SessionSnapshotOperations,
  session: WorkspaceSessionState,
  hostId?: string | null
): void {
  setSession(owner, session, hostId, true)
}

export function patchDetachedWorkspaceSession(
  owner: SessionSnapshotOperations,
  patch: WorkspaceSessionPatch,
  hostId?: string | null
): void {
  patchSession(owner, patch, hostId, true)
}

type SessionWriter = {
  setWorkspaceSession?(session: WorkspaceSessionState, hostId?: string | null): void
}
/** The close/retire owners keep their aliases only for the durable mutation and rollback. */
export function setBorrowedWorkspaceSession(
  owner: SessionWriter | null | undefined,
  session: WorkspaceSessionState,
  hostId?: string | null
): void {
  if (owner && isSnapshotOwner(owner)) {
    setSession(owner, session, hostId)
  } else {
    owner!.setWorkspaceSession!(session, hostId)
  }
}

function isSnapshotOwner(owner: SessionWriter): owner is SessionSnapshotOperations {
  return sessionSnapshotOperationsContext in owner
}

export function admitDetachedWorkspaceSessionInput(
  owner: SessionSnapshotOperations,
  input: unknown,
  hostId?: string | null
): void {
  owner[sessionSnapshotOperationsContext].runtime.workspaceSessionFieldCapture.admit(
    sessionDomain(hostId),
    input
  )
}
