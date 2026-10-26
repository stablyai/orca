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
import { windowsFsPath } from '../../wsl/wsl-unc-drive-fs-path'
import {
  assertLocalWriteTargetIsRegularFile,
  FileTooLargeError,
  openLocalRegularFile,
  readLocalFileBounded
} from './local-regular-file-read'

const HASH_SLICE_BYTES = 1024 * 1024

/** Yield between hash slices so large editor saves cannot monopolize the main loop. */
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
    // Error messages contain user paths that can spell arbitrary error codes.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return compareDiskWritePrecondition(precondition, null, content)
    }
    throw error
  }
  const { handle, stats } = opened
  try {
    const written = Buffer.from(content, 'utf8')
    const expectedLength = diskBaselineSignatureLength(precondition.expectedSignature)
    // Impossible decoded lengths reject before reading large files.
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
      // Growth past the bounded read proves neither baseline nor save can match.
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
    // U+FFFD alone cannot distinguish literal text from replaced invalid bytes.
    return precondition.requireLosslessUtf8 && !isUtf8(buffer) ? 'not-utf8' : null
  } finally {
    await handle.close()
  }
}

const editorWritesByPath = new Map<string, Promise<void>>()
const editorWritesByInode = new Map<string, Promise<void>>()

// Match Linux's symlink-hop limit.
const MAX_SYMLINK_HOPS = 40

/** Follow dangling-target chains without realpath; loops cannot share a proven write lock. */
async function followSymlinks(filePath: string): Promise<string | null> {
  let current = filePath
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    let target: string
    try {
      target = await readlink(current)
    } catch {
      return current
    }
    // Relative link targets resolve against the link's real parent.
    const linkFolder = await realpath(dirname(current)).catch(() => dirname(current))
    current = resolve(linkFolder, target)
  }
  return null
}

/** Lock real-parent/folded-name paths after following links; folding may over-serialize, and missing targets keep a stable key. */
async function editorWritePathKey(requestedPath: string): Promise<string | null> {
  const filePath = await followSymlinks(requestedPath)
  if (filePath === null) {
    return null
  }
  let parentKey: string
  try {
    parentKey = await serializedParentDirectoryKey(filePath)
  } catch {
    // Lock ordering must not prevent saves on volumes lacking realpath support.
    parentKey = normalize(dirname(filePath))
  }
  return join(parentKey, basename(filePath).normalize('NFC').toLowerCase())
}

/** Null for missing/unknown inodes; stat follows symlinks. */
async function editorWriteInodeKey(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath, { bigint: true })
    // Ignore inode zero, shared by unrelated files on some 9P/SMB mounts.
    return stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`
  } catch {
    return null
  }
}

/** Serialize compare/write by canonical path then inode across IPC/runtime writers; external-process races remain possible during the read. */
export async function writeLocalTextFileWithDiskPrecondition(
  requestedPath: string,
  content: string,
  precondition: FileWriteDiskPrecondition | undefined
): Promise<FileWriteResult> {
  // A UNC drive-mount file opens only through its drive path; locks key on that one spelling.
  const filePath = windowsFsPath(requestedPath)
  // Unguarded writes bypass locks held by stalled guarded saves.
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
    // Refuse symlink loops whose baseline and shared lock cannot be proven.
    return { ok: false, diskConflict: 'changed' }
  }
  return runKeyedSerializedOperation(editorWritesByPath, pathKey, async () => {
    const inodeKey = await editorWriteInodeKey(filePath)
    return inodeKey === null
      ? compareAndWrite()
      : runKeyedSerializedOperation(editorWritesByInode, inodeKey, compareAndWrite)
  })
}
