import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { durableWriteTempPath, renameDurable } from '../../durable-file-write'
import type { PrimaryStateWriteOperationsContext } from './primary-state-write-context'
import {
  canReuseDurableProfileState,
  markPrimaryStateWriteDurable
} from './primary-state-write-runtime'

export async function writeJsonProfileState(
  { runtime, serialization, backups }: PrimaryStateWriteOperationsContext,
  gen: number
): Promise<boolean> {
  const built = serialization.buildStateToSave()
  const { stateHash, protectedSecretUpdates } = built
  // Why: don't rewrite a byte-identical multi-MB file when state nets out to already-persisted.
  if (canReuseDurableProfileState(runtime, stateHash)) {
    runtime.dirtyProfileStateDomains = new Set()
    runtime.pendingAutomationRunsAfter = undefined
    markPrimaryStateWriteDurable(runtime, gen)
    return true
  }
  const dataFile = runtime.dataFile
  const payload = built.payload
  const dir = dirname(dataFile)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const tmpFile = durableWriteTempPath(dataFile)

  // Why: on any write/rename failure, remove the tmp file so it doesn't leave a multi-MB orphan.
  let renamed = false
  try {
    // Why: fsync before rename, then fsync the directory; see writeFileDurable.
    const handle = await open(tmpFile, 'w')
    try {
      // Already UTF-8 bytes: passing the string here would re-encode the whole state on the main thread.
      await handle.writeFile(payload)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Why: if flush() bumped writeGeneration mid-write, it already wrote fresher state; don't overwrite it.
    if (runtime.writeGeneration !== gen) {
      return false
    }
    runtime.inFlightAsyncTmpFile = tmpFile
    try {
      await renameDurable(tmpFile, dataFile)
      renamed = true
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
        runtime.writeGeneration === gen
      ) {
        throw error
      }
    } finally {
      if (runtime.inFlightAsyncTmpFile === tmpFile) {
        runtime.inFlightAsyncTmpFile = null
      }
    }
    // Why re-check gen: a mutation or sync flush during rename makes the installed hash ambiguous; invalidate the no-op guard.
    if (renamed && runtime.writeGeneration === gen) {
      runtime.lastWrittenStateHash = stateHash
      runtime.protectedSecrets.commitRetentionUpdates(protectedSecretUpdates)
    } else if (renamed) {
      runtime.lastWrittenStateHash = null
    }
    if (renamed) {
      runtime.dirtyProfileStateDomains = new Set()
      runtime.pendingAutomationRunsAfter = undefined
      markPrimaryStateWriteDurable(runtime, gen)
    }
  } finally {
    if (!renamed) {
      await rm(tmpFile).catch(() => {})
    }
  }
  if (!renamed) {
    return false
  }
  // Why (#1158): rotate only after the primary rename while this write still owns its generation.
  if (runtime.writeGeneration !== gen) {
    return true
  }
  await backups.rotateBackupsAsync(dataFile)
  return true
}
