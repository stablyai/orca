import type { StoreRuntimeState } from './store-runtime-state'
import type {
  SurfaceStorageCommand,
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'
import {
  surfaceAdmissionValid,
  captureSurfaceAdmission
} from '../../workspace-surfaces/surface-admission-capture'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import { readSurfaceRuntimeSession } from './surface-committed-publication'

export async function surfaceCommandAdmissionCanExecute(
  runtime: StoreRuntimeState,
  command: SurfaceStorageMutation
): Promise<boolean> {
  if (surfaceAdmissionValid(command)) {
    return true
  }
  if (command.type !== 'layout' && command.type !== 'replace' && command.type !== 'move') {
    return false
  }
  const authority = runtime.profileStateAuthority
  const receipt = await authority?.readSurface?.({
    type: 'receipt',
    hostId: command.hostId,
    callerId: command.request.callerId,
    commandId: command.request.commandId
  })
  // An existing receipt is an observation; the repository still checks its exact fingerprint.
  return receipt?.type === 'receipt' && receipt.receipt !== null
}

export function refusedSurfaceCommandAdmission(
  runtime: StoreRuntimeState,
  command: SurfaceStorageMutation
): SurfaceStorageResult {
  const reader = runtime.workspaceSurfaces!
  const hostId = normalizeExecutionHostId(command.hostId)!
  return {
    hostId,
    host: {
      terminalInitialized: reader.initialized(hostId),
      chatInitialization: reader.chatInitialized?.(hostId) ? 'verified' : 'unknown',
      revision: reader.revision?.(hostId) ?? 0,
      surfaces: [...reader.all(hostId)]
    },
    session: readSurfaceRuntimeSession(runtime, hostId),
    allocations: [],
    outcome: { status: 'conflict', code: 'surface_changed', current: null }
  }
}

export function captureWorkspaceSurfaceAdmission(
  runtime: StoreRuntimeState,
  command: SurfaceStorageCommand
): void {
  const reader = runtime.workspaceSurfaces
  if (reader) {
    const sessions = [
      runtime.state.workspaceSession,
      ...Object.values(runtime.state.workspaceSessionsByHostId ?? {})
    ]
    captureSurfaceAdmission(
      reader,
      command,
      sessions.filter((session): session is NonNullable<typeof session> => session !== undefined)
    )
  }
}
