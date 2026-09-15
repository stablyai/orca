import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  RuntimeUploadFileStreamRequest,
  StagedRuntimeUploadFileIdentity
} from '../../shared/runtime-upload-staging-contract'
import { authorizeExternalPath } from './filesystem-auth'
import { formatByteCeiling, REMOTE_IMPORT_MAX_FILE_BYTES } from './runtime-import-limits'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  RUNTIME_MANUALLY_DISCONNECTED_MESSAGE
} from './runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

// Why: base64 turns 3 bytes into 4 chars, so a 384 KiB slice lands on the wire
// as exactly 512 KiB — the chunk size the renderer used before streaming.
export const RUNTIME_UPLOAD_SLICE_BYTES = 384 * 1024

const RUNTIME_UPLOAD_CHUNK_TIMEOUT_MS = 30_000

export type RuntimeUploadFileStreamArgs = RuntimeUploadFileStreamRequest & {
  /** Resolved environment id, not a selector: the manual-disconnect check keys on it. */
  environmentId: string
  userDataPath: string
  /** Aborts the transfer; the caller's lifetime is what raises it today. */
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

  // Why: relativePath is the hidden .orca-upload-<nonce> temp destination, so a
  // dropped file names its source instead of a path the user never chose.
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

    // Why: the handle is what the slices are read from, so the staged identity
    // has to hold here too — checking only the pre-open lstat leaves a window
    // where the path is swapped between lstat and open.
    assertMatchesStagedIdentity(openedStat, args.expected, displayPath)

    const totalBytes = openedStat.size

    // Why: enforced again where the bytes actually move. Staging is a separate
    // call, so the ceiling only holds here if this boundary checks it too.
    if (totalBytes > REMOTE_IMPORT_MAX_FILE_BYTES) {
      throw new Error(
        `'${displayPath}' is ${formatByteCeiling(totalBytes)}, over the ` +
          `${formatByteCeiling(REMOTE_IMPORT_MAX_FILE_BYTES)} per-file remote import limit`
      )
    }

    if (totalBytes === 0) {
      // Why: a zero-byte source produces no slices, but the destination still
      // has to exist before commitUpload renames it into place.
      await sendChunk(args, '', false)
    } else {
      const buffer = Buffer.allocUnsafe(Math.min(RUNTIME_UPLOAD_SLICE_BYTES, totalBytes))
      let offset = 0

      while (offset < totalBytes) {
        // Why: checked per slice, so an abort stops the transfer at the next
        // boundary instead of after the whole file has moved.
        args.signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)

        if (bytesRead === 0) {
          throw new Error(`File truncated during upload: '${displayPath}'`)
        }

        await sendChunk(args, buffer.subarray(0, bytesRead).toString('base64'), offset > 0)
        offset += bytesRead
      }
    }

    // Why: the destination is a temp path the caller commits, so a source
    // rewritten mid-transfer is caught before anything lands at the final path.
    // mtime catches an in-place edit that kept the size. An empty source runs
    // this too: its chunk is still a round trip the source can change during.
    const afterReadStat = await handle.stat()

    if (afterReadStat.mtimeMs !== openedStat.mtimeMs || !isSameFile(afterReadStat, openedStat)) {
      throw new Error(`File changed during upload: '${displayPath}'`)
    }

    return { byteLength: totalBytes }
  } finally {
    await handle.close()
  }
}

/**
 * Refuse a source that no longer matches what staging measured.
 *
 * Inode and device are compared only when both sides report one, because some
 * filesystems leave them at 0; size and mtime then carry the check alone.
 */
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

/** Same inode on the same device, where the filesystem reports them. */
function isSameFile(a: Stats, b: Stats): boolean {
  return (
    a.size === b.size &&
    (a.ino === 0 || b.ino === 0 || a.ino === b.ino) &&
    (a.dev === 0 || b.dev === 0 || a.dev === b.dev)
  )
}

/** Append one base64 slice, carrying the host guards that must hold per chunk. */
async function sendChunk(
  args: RuntimeUploadFileStreamArgs,
  contentBase64: string,
  append: boolean
): Promise<void> {
  // Why: the renderer's per-chunk calls went through an IPC handler that refuses
  // a manually disconnected environment. The loop lives in main now, so it makes
  // the same check, or a disconnect mid-upload keeps pushing bytes to that host.
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
    // Why: re-checked per chunk, so a re-pair mid-upload aborts instead of
    // appending the rest of the file on a different host.
    args.expectedEnvironmentPairingRevision,
    undefined,
    {
      // Why: a replacement runtime keeps the pairing but invalidates its
      // predecessor's capability proof, so the identity rides every chunk too.
      expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId,
      signal: args.signal
    }
  )

  if (response.ok !== true) {
    throw new Error(response.error.message || response.error.code)
  }
}

function resolveEntrySourcePath(sourceRootPath: string, entryRelativePath: string): string {
  // Why: staging resolves before authorizing, so the streamer has to agree on
  // the same absolute path or the two checks can disagree.
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

  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
    throw new Error(`Path escaped upload root during upload: '${displayPath}'`)
  }
}
