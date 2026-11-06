import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  RuntimeUploadFileStreamRequest,
  StagedRuntimeUploadFileIdentity
} from '../../shared/runtime-upload-staging-contract'
import { formatByteCeiling, REMOTE_IMPORT_MAX_FILE_BYTES } from './runtime-import-limits'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
} from './runtime-environments/runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'

// Base64 expands 384 KiB into the established 512 KiB wire chunk.
export const RUNTIME_UPLOAD_SLICE_BYTES = 384 * 1024

const RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS = 30_000

export type RuntimeUploadFileStreamArgs = RuntimeUploadFileStreamRequest & {
  /** Resolved environment id, not a selector: the manual-disconnect check keys on it. */
  environmentId: string
  userDataPath: string
  signal?: AbortSignal
}

/** Stream with one slice in memory rather than buffering and encoding the whole file. */
export async function streamExternalFileToRuntime(
  args: RuntimeUploadFileStreamArgs
): Promise<{ byteLength: number }> {
  return streamExternalFileSlices({
    sourceRootPath: args.sourceRootPath,
    entryRelativePath: args.entryRelativePath,
    expected: args.expected,
    signal: args.signal,
    maxFileBytes: REMOTE_IMPORT_MAX_FILE_BYTES,
    limitLabel: 'per-file remote import limit',
    writeSlice: (contentBase64, offset) => sendChunk(args, contentBase64, offset > 0)
  })
}

export type ExternalFileSliceStreamArgs = {
  /** Client-local path of the dropped source (file, or root of a dropped directory). */
  sourceRootPath: string
  /** Path of this file within the dropped directory; empty when the source is a file. */
  entryRelativePath: string
  expected: StagedRuntimeUploadFileIdentity
  signal?: AbortSignal
  maxFileBytes: number
  /** Names the ceiling in the refusal, e.g. "per-file remote import limit". */
  limitLabel: string
  /** Sends one base64 slice; `offset` is in source bytes. An empty file sends one empty slice. */
  writeSlice: (contentBase64: string, offset: number) => Promise<void>
}

/** Recheck staged source identity while streaming; refuse changes before committing the temporary destination. */
export async function streamExternalFileSlices(
  args: ExternalFileSliceStreamArgs
): Promise<{ byteLength: number }> {
  const sourcePath = resolveEntrySourcePath(args.sourceRootPath, args.entryRelativePath)

  // The hidden upload destination is not a user-chosen path; name the source in errors.
  const displayPath = args.entryRelativePath || basename(args.sourceRootPath)
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
  assertMatchesStagedIdentity(lstatResult, args.expected, displayPath)

  args.signal?.throwIfAborted()

  const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`Unsupported file type in '${displayPath}'`)
    }
    if (!isSameFile(openedStat, lstatResult)) {
      throw new Error(`File changed during upload: '${displayPath}'`)
    }
    // Validate the opened handle too: the source can be swapped between lstat and open.
    assertMatchesStagedIdentity(openedStat, args.expected, displayPath)

    const totalBytes = openedStat.size
    // Staging and transfer are separate calls; enforce the size limit where bytes move.
    if (totalBytes > args.maxFileBytes) {
      throw new Error(
        `'${displayPath}' is ${formatByteCeiling(totalBytes)}, over the ` +
          `${formatByteCeiling(args.maxFileBytes)} ${args.limitLabel}`
      )
    }
    if (totalBytes === 0) {
      // Empty sources still need a temporary destination for commitUpload to rename.
      await args.writeSlice('', 0)
    } else {
      const buffer = Buffer.allocUnsafe(Math.min(RUNTIME_UPLOAD_SLICE_BYTES, totalBytes))
      let offset = 0
      while (offset < totalBytes) {
        args.signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
        if (bytesRead === 0) {
          throw new Error(`File truncated during upload: '${displayPath}'`)
        }
        await args.writeSlice(buffer.subarray(0, bytesRead).toString('base64'), offset)
        offset += bytesRead
      }
    }

    // Recheck before commit, including empty-file round trips; mtime catches same-size in-place edits.
    const afterReadStat = await handle.stat()
    if (afterReadStat.mtimeMs !== openedStat.mtimeMs || !isSameFile(afterReadStat, openedStat)) {
      throw new Error(`File changed during upload: '${displayPath}'`)
    }
    return { byteLength: totalBytes }
  } finally {
    await handle.close()
  }
}

/** Some filesystems report zero inode/device; compare them only when available, retaining size/mtime checks. */
function assertMatchesStagedIdentity(
  observed: Stats,
  expected: StagedRuntimeUploadFileIdentity,
  displayPath: string
): void {
  const changed =
    observed.size !== expected.byteLength ||
    observed.mtimeMs !== expected.modifiedAtMs ||
    (expected.inode !== 0 && observed.ino !== 0 && observed.ino !== expected.inode) ||
    (expected.deviceId !== 0 && observed.dev !== 0 && observed.dev !== expected.deviceId)
  if (changed) {
    throw new Error(`File changed since it was staged: '${displayPath}'`)
  }
}

function isSameFile(a: Stats, b: Stats): boolean {
  return (
    a.size === b.size &&
    (a.ino === 0 || b.ino === 0 || a.ino === b.ino) &&
    (a.dev === 0 || b.dev === 0 || a.dev === b.dev)
  )
}

async function sendChunk(
  args: RuntimeUploadFileStreamArgs,
  contentBase64: string,
  append: boolean
): Promise<void> {
  // Main now owns chunk dispatch; each slice must still honor a concurrent manual disconnect.
  if (isRuntimeEnvironmentManuallyDisconnected(args.environmentId)) {
    throw new Error(RUNTIME_MANUALLY_DISCONNECTED_MESSAGE)
  }
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
    // Abort if re-pairing changes the host between chunks.
    args.expectedEnvironmentPairingRevision,
    undefined,
    {
      // Restarts retain pairing but invalidate runtime capability proof; pin every chunk to its runtime.
      expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId,
      signal: args.signal
    }
  )
  if (response.ok !== true) {
    throw new Error(response.error.message || response.error.code)
  }
}

function resolveEntrySourcePath(sourceRootPath: string, entryRelativePath: string): string {
  // Resolve exactly as staging does so both identity checks refer to the same source.
  const root = resolve(sourceRootPath)
  return entryRelativePath ? join(root, entryRelativePath) : root
}

async function assertEntryInsideRoot(
  sourceRootPath: string,
  candidatePath: string,
  displayPath: string
): Promise<void> {
  const rootRealPath = await realpath(sourceRootPath)
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  // Names beginning with .. are valid; only parent traversal escapes.
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
    throw new Error(`Path escaped upload root during upload: '${displayPath}'`)
  }
}
