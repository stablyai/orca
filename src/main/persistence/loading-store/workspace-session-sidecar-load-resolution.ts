// Resolves embedded and partitioned workspace sessions into the in-memory load state.
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  isDefaultWorkspaceSession,
  listPartitionHostIds,
  readPartitionWithRecovery,
  workspaceSessionHash,
  type DirtyPartition,
  type LoadResolution
} from './workspace-session-sidecar-files'

export type WorkspaceSessionSidecarLoadArguments = {
  workspaceSession: WorkspaceSessionState
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  embeddedLocalPresent: boolean
  embeddedHostIds: ReadonlySet<ExecutionHostId>
  embeddedPayloadPresent: boolean
  embeddedGenerationByHostId?: Partial<Record<ExecutionHostId, number>>
  coreRestoredFromBackup?: boolean
  replacementPending?: boolean
}

type WorkspaceSessionSidecarLoadState = {
  dataFile: string
  sessions: Map<ExecutionHostId, WorkspaceSessionState>
  generations: Map<ExecutionHostId, number>
  durableGenerations: Map<ExecutionHostId, number>
  dirty: Map<ExecutionHostId, DirtyPartition>
  synchronizedCoreHashes: Map<ExecutionHostId, string>
  pendingPruneHostIds: Set<ExecutionHostId>
}

export function resolveWorkspaceSessionSidecarLoad(
  state: WorkspaceSessionSidecarLoadState,
  args: WorkspaceSessionSidecarLoadArguments
): LoadResolution {
  state.sessions.clear()
  state.generations.clear()
  state.durableGenerations.clear()
  state.dirty.clear()
  state.synchronizedCoreHashes.clear()
  state.pendingPruneHostIds.clear()

  const replacementPending =
    args.replacementPending === true && args.coreRestoredFromBackup !== true
  const existingSidecarHostIds = new Set(listPartitionHostIds(state.dataFile))
  const sidecarHostIds = replacementPending
    ? new Set<ExecutionHostId>()
    : new Set(existingSidecarHostIds)
  if (args.embeddedLocalPresent) {
    sidecarHostIds.add(LOCAL_EXECUTION_HOST_ID)
  }
  for (const hostId of args.embeddedHostIds) {
    sidecarHostIds.add(hostId)
  }
  if (replacementPending) {
    for (const hostId of existingSidecarHostIds) {
      if (!sidecarHostIds.has(hostId)) {
        state.pendingPruneHostIds.add(hostId)
      }
    }
  }

  for (const hostId of sidecarHostIds) {
    const loaded = readPartitionWithRecovery(state.dataFile, hostId)
    const embedded =
      hostId === LOCAL_EXECUTION_HOST_ID
        ? args.workspaceSession
        : args.workspaceSessionsByHostId?.[hostId]
    const embeddedPresent =
      hostId === LOCAL_EXECUTION_HOST_ID
        ? args.embeddedLocalPresent
        : args.embeddedHostIds.has(hostId)
    const embeddedIsUnmaterializedLocalDefault =
      hostId === LOCAL_EXECUTION_HOST_ID &&
      !loaded &&
      embeddedPresent &&
      embedded !== undefined &&
      isDefaultWorkspaceSession(embedded)
    const embeddedGeneration = args.embeddedGenerationByHostId?.[hostId]
    const embeddedHash = embedded ? workspaceSessionHash(embedded) : undefined
    if (embeddedHash) {
      state.synchronizedCoreHashes.set(hostId, embeddedHash)
    } else if (loaded?.envelope.lastSynchronizedCoreHash) {
      state.synchronizedCoreHashes.set(hostId, loaded.envelope.lastSynchronizedCoreHash)
    }
    const rollbackPayloadChanged =
      embeddedGeneration === undefined &&
      loaded?.envelope.lastSynchronizedCoreHash !== undefined &&
      embeddedHash !== loaded.envelope.lastSynchronizedCoreHash
    const embeddedIsNewer =
      !embeddedIsUnmaterializedLocalDefault &&
      embeddedPresent &&
      embedded !== undefined &&
      (!loaded ||
        (!args.coreRestoredFromBackup &&
          (replacementPending ||
            (embeddedGeneration === undefined
              ? loaded.envelope.lastSynchronizedCoreHash === undefined || rollbackPayloadChanged
              : embeddedGeneration > loaded.envelope.writeGeneration))))
    const session = embeddedIsNewer ? embedded : loaded?.envelope.session
    if (!session) {
      continue
    }
    state.sessions.set(hostId, session)
    const generation = loaded?.envelope.writeGeneration ?? 0
    state.generations.set(hostId, generation)
    state.durableGenerations.set(hostId, loaded ? generation : -1)
    if (embeddedIsNewer || loaded?.repaired || loaded?.recovered) {
      state.dirty.set(hostId, { trigger: 'migration', migration: embeddedIsNewer })
    }
  }

  if (!state.sessions.has(LOCAL_EXECUTION_HOST_ID)) {
    state.sessions.set(LOCAL_EXECUTION_HOST_ID, args.workspaceSession)
    state.generations.set(LOCAL_EXECUTION_HOST_ID, 0)
    state.durableGenerations.set(LOCAL_EXECUTION_HOST_ID, -1)
  }

  const workspaceSessionsByHostId: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = {}
  for (const [hostId, session] of state.sessions) {
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      workspaceSessionsByHostId[hostId] = session
    }
  }
  return {
    workspaceSession: state.sessions.get(LOCAL_EXECUTION_HOST_ID)!,
    workspaceSessionsByHostId
  }
}
