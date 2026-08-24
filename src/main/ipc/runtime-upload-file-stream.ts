import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { authorizeExternalPath } from './filesystem-auth'
import { RuntimeUploadCancelledError } from './runtime-upload-cancellation'
import { formatByteCeiling, REMOTE_IMPORT_MAX_FILE_BYTES } from './runtime-import-limits'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

// Why: base64 turns 3 bytes into 4 chars, so a 384 KiB slice lands on the wire
// as exactly 512 KiB — the chunk size the renderer used before streaming.
export const RUNTIME_UPLOAD_SLICE_BYTES = 384 * 1024

const RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS = 30_000

export type RuntimeUploadFileStreamArgs = {
  userDataPath: string
  environmentId: string
  /** Client-local path of the dropped source (file, or root of a dropped directory). */
  sourceRootPath: string
  /** Path of this file within the dropped directory; empty when the source is a file. */
  entryRelativePath: string
  /**
   * Size staging measured and validated against the import ceilings.
   *
   * Staging and upload are separate IPC calls, so a source can be replaced or
   * grown in between. Without this the streamer would take the current size as
   * authoritative and happily move a file the ceilings had already rejected.
   */
  expectedByteLength?: number
  worktree: string
  /** Destination path on the runtime, relative to the worktree. */
  relativePath: string
  expectedExecutionHostId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedEnvironmentPairingRevision?: number
  /** Called after each slice lands, so the drop UI can show how far along the file is. */
  onProgress?: (progress: { sentBytes: number; totalBytes: number }) => void
  /** Aborts between slices; the destination is a temp path the caller removes. */
  signal?: AbortSignal
}

/**
 * Stream one client-local file to a runtime environment in slices.
 *
 * Replaces reading the whole file into memory and base64-encoding it before the
 * first byte moves. Peak memory is one slice, so imports are no longer bounded
 * by main-process heap.
 */
export async function streamExternalFileToRuntime(
  args: RuntimeUploadFileStreamArgs
): Promise<{ byteLength: number }> {
  const sourcePath = resolveEntrySourcePath(args.sourceRootPath, args.entryRelativePath)

  // Why: parity with staging — an OS drop authorizes the paths it hands over.
  authorizeExternalPath(sourcePath)

  const displayPath = args.entryRelativePath || args.relativePath
  const lstatResult = await lstat(sourcePath)
  if (lstatResult.isSymbolicLink()) {
    throw new Error(`Symlink not allowed in '${displayPath}'`)
  }
  if (!lstatResult.isFile()) {
    throw new Error(`Unsupported file type in '${displayPath}'`)
  }
  if (args.entryRelativePath) {
    await assertEntryInsideRoot(args.sourceRootPath, sourcePath, displayPath)
  }

  const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`Unsupported file type in '${displayPath}'`)
    }
    if (
      openedStat.size !== lstatResult.size ||
      (lstatResult.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== lstatResult.ino) ||
      (lstatResult.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== lstatResult.dev)
    ) {
      throw new Error(`File changed during upload: '${displayPath}'`)
    }

    const totalBytes = openedStat.size
    if (args.expectedByteLength !== undefined && totalBytes !== args.expectedByteLength) {
      throw new Error(`File changed since it was staged: '${displayPath}'`)
    }
    // Why: enforced again where the bytes actually move. Staging is a separate
    // call, so the ceiling only holds here if this boundary checks it too.
    if (totalBytes > REMOTE_IMPORT_MAX_FILE_BYTES) {
      throw new Error(
        `'${displayPath}' is ${formatByteCeiling(totalBytes)}, over the ` +
          `${formatByteCeiling(REMOTE_IMPORT_MAX_FILE_BYTES)} per-file remote import limit`
      )
    }
    throwIfCancelled(args.signal)
    // Why: a zero-byte source produces no slices, but the destination still has
    // to exist before commitUpload renames it into place.
    if (totalBytes === 0) {
      await sendChunk(args, '', false)
      args.onProgress?.({ sentBytes: 0, totalBytes: 0 })
      return { byteLength: 0 }
    }

    const buffer = Buffer.allocUnsafe(Math.min(RUNTIME_UPLOAD_SLICE_BYTES, totalBytes))
    let offset = 0
    while (offset < totalBytes) {
      // Why: checked between slices rather than mid-flight, so a cancelled upload
      // still leaves a well-formed partial temp file for the caller to delete.
      throwIfCancelled(args.signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
      if (bytesRead === 0) {
        throw new Error(`File truncated during upload: '${displayPath}'`)
      }
      await sendChunk(args, buffer.subarray(0, bytesRead).toString('base64'), offset > 0)
      offset += bytesRead
      // Why: reported after the chunk is acknowledged, so the bar tracks bytes the
      // runtime actually has rather than bytes handed to the socket.
      args.onProgress?.({ sentBytes: offset, totalBytes })
    }

    // Why: the destination is a temp path the caller commits, so a source that
    // changed mid-read is caught before anything lands at the final path.
    const afterReadStat = await handle.stat()
    if (afterReadStat.size !== totalBytes) {
      throw new Error(`File changed during upload: '${displayPath}'`)
    }
    return { byteLength: totalBytes }
  } finally {
    await handle.close()
  }
}

async function sendChunk(
  args: RuntimeUploadFileStreamArgs,
  contentBase64: string,
  append: boolean
): Promise<void> {
  const response = await callRuntimeEnvironment(
    args.userDataPath,
    args.environmentId,
    'files.writeBase64Chunk',
    {
      worktree: args.worktree,
      relativePath: args.relativePath,
      contentBase64,
      append,
      expectedSshTargetId: args.expectedSshTargetId,
      expectedSshConnectionGeneration: args.expectedSshConnectionGeneration,
      expectedExecutionHostId: args.expectedExecutionHostId
    },
    RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS,
    // Why: re-checked per chunk, so a re-pair mid-upload aborts instead of
    // appending the rest of the file on a different host.
    args.expectedEnvironmentPairingRevision
  )
  if (response.ok !== true) {
    throw new Error(response.error.message || response.error.code)
  }
}

function resolveEntrySourcePath(sourceRootPath: string, entryRelativePath: string): string {
  return entryRelativePath ? join(sourceRootPath, entryRelativePath) : sourceRootPath
}

async function assertEntryInsideRoot(
  sourceRootPath: string,
  candidatePath: string,
  displayPath: string
): Promise<void> {
  const rootRealPath = await realpath(sourceRootPath)
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
    throw new Error(`Path escaped upload root during upload: '${displayPath}'`)
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RuntimeUploadCancelledError()
  }
}
