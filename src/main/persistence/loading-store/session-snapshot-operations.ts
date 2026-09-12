import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'

import { workspaceSessionPatchNeedsFullNormalization } from './terminal-session-cleanup'

import { setLocalWorkspaceSession } from './workspace-session-snapshot-publication'
import type { StoreRuntimeState } from './store-runtime-state'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import type { WriteSchedulingOperations } from './write-scheduling'
import { resolveHostId, setHostWorkspaceSession } from './session-host-partitions'
import { scheduleSave } from './write-scheduling'

type SessionSnapshotOperationsRuntime = Pick<
  StoreRuntimeState,
  'pendingSnapshotFileWork' | 'state' | 'terminalScrollbackSnapshotStorage'
>

const sessionSnapshotOperationsContext = Symbol('SessionSnapshotOperations')
type SessionSnapshotOperationsContext = {
  runtime: SessionSnapshotOperationsRuntime
  sessions: SessionHostPartitionOperations
  bindingRecovery: TerminalBindingRecoveryOperations
  scheduling: WriteSchedulingOperations
}

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
    const resolved = resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      setLocalWorkspaceSession(this, session)
      return
    }
    setHostWorkspaceSession(this[sessionSnapshotOperationsContext].sessions, resolved, session)
  }

  stageWorkspaceSessionBeforeUnload(
    session: PersistedState['workspaceSession'],
    hostId?: string | null
  ): void {
    const resolved = resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      setLocalWorkspaceSession(this, session, true)
      return
    }
    setHostWorkspaceSession(this[sessionSnapshotOperationsContext].sessions, resolved, session)
  }

  patchWorkspaceSession(patch: WorkspaceSessionPatch, hostId?: string | null): void {
    const resolved = resolveHostId(hostId)
    // Why: the debounced hot path sends only changed slices; scalar/UI patches skip terminal normalization, topology patches keep stale-PTY protections.
    let next: WorkspaceSessionState = {
      ...this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(resolved),
      ...patch
    }
    if (workspaceSessionPatchNeedsFullNormalization(patch)) {
      this.setWorkspaceSession(next, resolved)
      return
    }
    if (Object.hasOwn(patch, 'browserUrlHistory')) {
      next = pruneWorkspaceSessionBrowserHistory(next)
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this[sessionSnapshotOperationsContext].runtime.state.workspaceSession = next
    } else {
      this[sessionSnapshotOperationsContext].runtime.state.workspaceSessionsByHostId = {
        ...this[sessionSnapshotOperationsContext].runtime.state.workspaceSessionsByHostId,
        [resolved]: next
      }
    }
    scheduleSave(this[sessionSnapshotOperationsContext].scheduling)
  }
}

export function getSessionSnapshotOperationsContext(owner: SessionSnapshotOperations) {
  return owner[sessionSnapshotOperationsContext]
}

export function installSessionSnapshotOperationsContext(
  target: object,
  source: SessionSnapshotOperations
): void {
  Object.defineProperty(target, sessionSnapshotOperationsContext, {
    value: source[sessionSnapshotOperationsContext]
  })
}
