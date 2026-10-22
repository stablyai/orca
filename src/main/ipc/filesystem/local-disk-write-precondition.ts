import { isUtf8 } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'
import {
  DiskBaselineSignatureBuilder,
  getDiskBaselineSignature,
  diskBaselineSignatureLength,
  utf8ByteSizeCanDecodeToLength
} from '../../../shared/disk-baseline-signature'
import {
  compareDiskWritePrecondition,
  FILE_WRITE_OK,
  FILE_WRITE_UNCHANGED,
  type FileWriteDiskComparison,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import { readlink, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'
import { serializedParentDirectoryKey } from '../../destination-serialized-local-rename'
import {
  assertLocalWriteTargetIsRegularFile,
  FileTooLargeError,
  openLocalRegularFile,
  readLocalFileBounded
} from './local-regular-file-read'

const HASH_SLICE_BYTES = 1024 * 1024

/** Why sliced: hashing tens of MB in one go stalls the main process; yielding keeps windows responsive. */
export async function diskSignatureOfUtf8(buffer: Buffer): Promise<string> {
  if (buffer.length <= HASH_SLICE_BYTES) {
    return getDiskBaselineSignature(buffer.toString('utf8'))
  }
  const decoder = new StringDecoder('utf8')
  const signature = new DiskBaselineSignatureBuilder()
  for (let offset = 0; offset < buffer.length; offset += HASH_SLICE_BYTES) {
    signature.update(decoder.write(buffer.subarray(offset, offset + HASH_SLICE_BYTES)))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return signature.update(decoder.end()).digest()
}

/** Reads the file the writer is about to replace and reports why it no longer matches the baseline. */
export async function checkLocalDiskWritePrecondition(
  filePath: string,
  precondition: FileWriteDiskPrecondition,
  content: string
): Promise<FileWriteDiskComparison> {
  let opened: Awaited<ReturnType<typeof openLocalRegularFile>>
  try {
    opened = await openLocalRegularFile(filePath)
  } catch (error) {
    // Why the code alone: the message quotes the path, which can spell any error.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return compareDiskWritePrecondition(precondition, null, content)
    }
    throw error
  }
  const { handle, stats } = opened
  try {
    const written = Buffer.from(content, 'utf8')
    const expectedLength = diskBaselineSignatureLength(precondition.expectedSignature)
    // Why: the signature pins the decoded length, so a size neither it nor the save can match skips reading a huge file.
    const baselineFits =
      expectedLength !== null && utf8ByteSizeCanDecodeToLength(stats.size, expectedLength)
    if (!baselineFits && stats.size !== written.length) {
      return 'changed'
    }
    let buffer: Buffer
    try {
      buffer = await readLocalFileBounded(
        handle,
        Math.max(baselineFits ? expectedLength * 3 : 0, written.length),
        stats.size
      )
    } catch (error) {
      // Why: grown past what the baseline or the save could match since the size check, so it changed.
      if (error instanceof FileTooLargeError) {
        return 'changed'
      }
      throw error
    }
    if (buffer.equals(written)) {
      return 'identical'
    }
    if (!baselineFits || (await diskSignatureOfUtf8(buffer)) !== precondition.expectedSignature) {
      return 'changed'
    }
    // Why bytes: a decoded U+FFFD may be a real character or replaced bytes; only the bytes tell.
    return precondition.requireLosslessUtf8 && !isUtf8(buffer) ? 'not-utf8' : null
  } finally {
    await handle.close()
  }
}

const editorWritesByPath = new Map<string, Promise<void>>()
const editorWritesByInode = new Map<string, Promise<void>>()

// Why 40: Linux's own limit, so any chain the OS can open resolves here too.
const MAX_SYMLINK_HOPS = 40

/**
 * Follows a symlink chain by hand, since realpath fails once its final target is missing. Null
 * for a chain that never ends (a loop), whose writes could not share one lock.
 */
async function followSymlinks(filePath: string): Promise<string | null> {
  let current = filePath
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    let target: string
    try {
      target = await readlink(current)
    } catch {
      return current
    }
    // Why the real folder: a relative `..` resolves against where the link really lives.
    const linkFolder = await realpath(dirname(current)).catch(() => dirname(current))
    current = resolve(linkFolder, target)
  }
  return null
}

/**
 * A file's canonical path: real parent plus a case- and Unicode-folded name (folding only
 * over-serializes). Symlinks are followed first, so a dangling link and its future target share it.
 */
async function editorWritePathKey(requestedPath: string): Promise<string | null> {
  const filePath = await followSymlinks(requestedPath)
  if (filePath === null) {
    return null
  }
  let parentKey: string
  try {
    parentKey = await serializedParentDirectoryKey(filePath)
  } catch {
    // Why: the key only orders saves; a volume that can't resolve real paths must still save.
    parentKey = normalize(dirname(filePath))
  }
  return join(parentKey, basename(filePath).normalize('NFC').toLowerCase())
}

/** The file's inode (stat follows symlinks), or null when missing or unknown. */
async function editorWriteInodeKey(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath, { bigint: true })
    // Why: 9P and some SMB mounts report inode 0 for every file.
    return stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`
  } catch {
    return null
  }
}

/**
 * Compare→write for editor saves, serialized per file across this process's IPC and runtime
 * writers so two clients holding one baseline can't both pass. Two locks, always in this order:
 * the canonical path (stable even while a queued save creates the file) and then, if it exists,
 * the inode (shared by symlink and hardlink aliases). Per file, so a read stuck on a dead mount
 * holds up only that file. A write by another process between the compare and the write is not
 * prevented; the window is one read long.
 */
export async function writeLocalTextFileWithDiskPrecondition(
  filePath: string,
  content: string,
  precondition: FileWriteDiskPrecondition | undefined
): Promise<FileWriteResult> {
  // Why: an unguarded write has nothing to compare, so it skips the locks a stuck guarded save holds.
  if (!precondition) {
    await assertLocalWriteTargetIsRegularFile(filePath)
    await writeFile(filePath, content, 'utf-8')
    return FILE_WRITE_OK
  }
  const compareAndWrite = async (): Promise<FileWriteResult> => {
    const diskConflict = await checkLocalDiskWritePrecondition(filePath, precondition, content)
    if (diskConflict === 'identical') {
      return FILE_WRITE_UNCHANGED
    }
    if (diskConflict) {
      return { ok: false, diskConflict }
    }
    await assertLocalWriteTargetIsRegularFile(filePath)
    await writeFile(filePath, content, 'utf-8')
    return FILE_WRITE_OK
  }
  const pathKey = await editorWritePathKey(filePath)
  if (pathKey === null) {
    // Why refuse: a link loop can't be compared or locked, and disk can't hold the baseline there.
    return { ok: false, diskConflict: 'changed' }
  }
  return runKeyedSerializedOperation(editorWritesByPath, pathKey, async () => {
    const inodeKey = await editorWriteInodeKey(filePath)
    return inodeKey === null
      ? compareAndWrite()
      : runKeyedSerializedOperation(editorWritesByInode, inodeKey, compareAndWrite)
  })
}
