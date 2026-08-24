import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  listPartitionHostIds,
  PARTITION_SCHEMA_VERSION,
  readPartitionWithRecovery,
  removePartitionFilesSync,
  workspaceSessionHash,
  writePartitionSync
} from './workspace-session-sidecar-files'

export function replaceWorkspaceSessionSidecarsSync(args: {
  dataFile: string
  workspaceSession: WorkspaceSessionState
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
}): Partial<Record<ExecutionHostId, number>> {
  const desired = new Map<ExecutionHostId, WorkspaceSessionState>([
    [LOCAL_EXECUTION_HOST_ID, args.workspaceSession]
  ])
  for (const [rawHostId, session] of Object.entries(args.workspaceSessionsByHostId ?? {})) {
    const hostId = normalizeExecutionHostId(rawHostId)
    if (hostId && hostId !== LOCAL_EXECUTION_HOST_ID && session) {
      desired.set(hostId, session)
    }
  }
  const writtenAt = Date.now()
  const generations: Partial<Record<ExecutionHostId, number>> = {}
  for (const [hostId, session] of desired) {
    const loaded = readPartitionWithRecovery(args.dataFile, hostId)
    const generation = (loaded?.envelope.writeGeneration ?? 0) + 1
    writePartitionSync(
      args.dataFile,
      {
        schemaVersion: PARTITION_SCHEMA_VERSION,
        hostId,
        writeGeneration: generation,
        writtenAt,
        lastSynchronizedCoreHash: workspaceSessionHash(session),
        session
      },
      JSON.stringify
    )
    generations[hostId] = generation
  }
  for (const hostId of listPartitionHostIds(args.dataFile)) {
    if (!desired.has(hostId)) {
      removePartitionFilesSync(args.dataFile, hostId)
    }
  }
  return generations
}
