import { randomUUID } from 'node:crypto'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  readTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import type { StoreRuntimeState } from './store-runtime-state'
import type { SessionHostPartitionOperations } from './session-host-partitions'

import {
  MAX_RUNTIME_SESSION_RECOVERY_ARCHIVE_BYTES,
  runtimeEditorDraftDigest,
  writeRuntimeSessionRecoveryArchive
} from './runtime-session-recovery-archive'

export function isRuntimeSessionRetired(
  runtime: Pick<StoreRuntimeState, 'state'>,
  hostId: string
): boolean {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return false
  }
  const archives = runtime.state.retiredRuntimeWorkspaceSessions ?? {}
  if (!Object.hasOwn(archives, host.id)) {
    return false
  }
  const archive = archives[host.id]
  return (
    typeof archive?.archiveFile === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(archive.archiveFile) &&
    typeof archive.retiredAt === 'number' &&
    Number.isFinite(archive.retiredAt) &&
    archive.retiredAt >= 0
  )
}

export async function retireRuntimeSessionPartition(
  runtime: Pick<
    StoreRuntimeState,
    | 'state'
    | 'dataFile'
    | 'runDurableMutation'
    | 'dirtyProfileStateDomains'
    | 'terminalScrollbackSnapshotStorage'
  >,
  sessions: SessionHostPartitionOperations,
  hostId: ExecutionHostId,
  hasNamespaceCustody?: () => boolean
): Promise<boolean> {
  const refs = new Set<string>()
  let archiveError: unknown
  const removed = await runtime.runDurableMutation(() => {
    const prior = runtime.state.workspaceSessionsByHostId?.[hostId]
    if (parseExecutionHostId(hostId)?.kind !== 'runtime' || !prior) {
      return { value: false, persist: false }
    }
    try {
      if (hasNamespaceCustody?.()) {
        return { value: false, persist: false }
      }
    } catch (error) {
      archiveError = error
      return { value: false, persist: false }
    }
    let snapshotBytes = 0
    const snapshots: Record<string, string> = {}
    const missingSnapshots: string[] = []
    for (const ref of collectTerminalScrollbackSnapshotRefs(prior)) {
      const buffer = readTerminalScrollbackSnapshotSync(
        ref,
        runtime.terminalScrollbackSnapshotStorage,
        { purpose: 'archive' }
      )
      snapshotBytes +=
        Buffer.byteLength(ref, 'utf8') * 2 +
        (buffer === null ? 0 : Buffer.byteLength(buffer, 'utf8'))
      if (snapshotBytes > MAX_RUNTIME_SESSION_RECOVERY_ARCHIVE_BYTES) {
        archiveError = new Error('Runtime session recovery archive exceeds 64 MiB')
        return { value: false, persist: false }
      }
      if (buffer === null) {
        missingSnapshots.push(ref)
      } else {
        snapshots[ref] = buffer
        refs.add(ref)
      }
    }
    const archiveFile = `${randomUUID()}.json`
    const retiredAt = Date.now()
    let dirtyDraftDigest: string | null = null
    // Archive first: a failed profile commit must leave both the active state and recoverable text.
    try {
      dirtyDraftDigest = runtimeEditorDraftDigest(prior)
      writeRuntimeSessionRecoveryArchive(runtime.dataFile, archiveFile, {
        version: 1,
        hostId,
        retiredAt,
        session: prior,
        snapshots,
        missingSnapshots
      })
    } catch (error) {
      archiveError = error
      return { value: false, persist: false }
    }
    const priorArchive = runtime.state.retiredRuntimeWorkspaceSessions?.[hostId]
    const nextPartitions = { ...runtime.state.workspaceSessionsByHostId }
    delete nextPartitions[hostId]
    runtime.state.workspaceSessionsByHostId = nextPartitions
    runtime.state.retiredRuntimeWorkspaceSessions = {
      ...runtime.state.retiredRuntimeWorkspaceSessions,
      [hostId]: { archiveFile, retiredAt, ...(dirtyDraftDigest ? { dirtyDraftDigest } : {}) }
    }
    runtime.dirtyProfileStateDomains?.add('workspaceSessionsByHostId')
    runtime.dirtyProfileStateDomains?.add('retiredRuntimeWorkspaceSessions')
    return {
      value: true,
      persist: true,
      rollback: () => {
        runtime.state.workspaceSessionsByHostId = {
          ...runtime.state.workspaceSessionsByHostId,
          [hostId]: prior
        }
        const archives = { ...runtime.state.retiredRuntimeWorkspaceSessions }
        if (priorArchive) {
          archives[hostId] = priorArchive
        } else {
          delete archives[hostId]
        }
        runtime.state.retiredRuntimeWorkspaceSessions = archives
      }
    }
  })
  if (archiveError !== undefined) {
    throw archiveError
  }
  if (!removed) {
    return false
  }
  invalidateLocalWorktreeMetadataPruneInputs()
  for (const owner of sessions.getWorkspaceSessionHostIds()) {
    for (const ref of collectTerminalScrollbackSnapshotRefs(sessions.getWorkspaceSession(owner))) {
      refs.delete(ref)
    }
  }
  // Shared fallback snapshots may still belong to another profile.
  const storage = { ...runtime.terminalScrollbackSnapshotStorage, fallbackSnapshotRoot: null }
  for (const ref of refs) {
    deleteTerminalScrollbackSnapshotSync(ref, storage)
  }
  return true
}
