import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from '../../../shared/bounded-secure-json-file'
import { stringifyJsonWithinByteLimit } from '../../../shared/node-bounded-json-stringify'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import type { StoreRuntimeState } from './store-runtime-state'

export const MAX_RUNTIME_SESSION_RECOVERY_ARCHIVE_BYTES = 64 * 1024 * 1024

export function writeRuntimeSessionRecoveryArchive(
  dataFile: string,
  archiveFile: string,
  value: unknown
): void {
  writeSecureJsonFileWithinLimit(
    join(dirname(dataFile), 'retired-runtime-sessions', archiveFile),
    value,
    MAX_RUNTIME_SESSION_RECOVERY_ARCHIVE_BYTES,
    { durable: true }
  )
}

function collectDirtyEditorRecords(
  session: WorkspaceSessionState
): Record<string, PersistedOpenFile[]> {
  const records: Record<string, PersistedOpenFile[]> = {}
  for (const workspace of Object.keys(session.openFilesByWorktree ?? {}).sort()) {
    const dirty =
      session.openFilesByWorktree?.[workspace]?.filter(
        (file) => typeof file.dirtyDraftContent === 'string'
      ) ?? []
    if (dirty.length > 0) {
      records[workspace] = dirty
    }
  }
  return records
}

function dirtyRecordDigest(records: Record<string, PersistedOpenFile[]>): string | null {
  if (Object.keys(records).length === 0) {
    return null
  }
  const entries = Object.entries(records).flatMap(([workspace, files]) =>
    files.map((file) => [
      workspace,
      file.filePath,
      file.relativePath,
      file.worktreeId,
      file.language,
      file.runtimeEnvironmentId ?? null,
      file.externalSshTargetId ?? null,
      file.isPreview === true,
      file.readOnly === true,
      file.liveTail === true,
      file.lastKnownDiskSignature ?? null,
      file.dirtyDraftContent
    ])
  )
  const payload = stringifyJsonWithinByteLimit(
    entries,
    MAX_RUNTIME_SESSION_RECOVERY_ARCHIVE_BYTES
  ).serialized
  return createHash('sha256').update(payload).digest('hex')
}

export function runtimeEditorDraftDigest(session: WorkspaceSessionState): string | null {
  return dirtyRecordDigest(collectDirtyEditorRecords(session))
}

export function preserveRetiredRuntimeEditorDrafts(
  runtime: Pick<
    StoreRuntimeState,
    'state' | 'dataFile' | 'writesFrozen' | 'quitFlushStarted' | 'profileMaintenancePending'
  >,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): boolean {
  const prior = runtime.state.retiredRuntimeWorkspaceSessions?.[hostId]
  if (!prior) {
    return false
  }
  const records = collectDirtyEditorRecords(session)
  const digest = dirtyRecordDigest(records)
  if (!digest || digest === prior.dirtyDraftDigest) {
    return false
  }
  const hostDigest = createHash('sha256').update(hostId).digest('hex')
  const archiveFile = `late-${hostDigest}-${digest}.json`
  // Content-addressed files preserve delayed drafts without reviving tabs or multiplying identical copies.
  writeRuntimeSessionRecoveryArchive(runtime.dataFile, archiveFile, {
    version: 1,
    kind: 'late-editor-draft',
    hostId,
    retiredAt: prior.retiredAt,
    session: { openFilesByWorktree: records }
  })
  if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
    return false
  }
  runtime.state.retiredRuntimeWorkspaceSessions = {
    ...runtime.state.retiredRuntimeWorkspaceSessions,
    [hostId]: { ...prior, dirtyDraftDigest: digest, lateDraftArchiveFile: archiveFile }
  }
  return true
}
