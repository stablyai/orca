import {
  formatByteCeiling,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from '../runtime-import-limits'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { classifyImportSource } from './filesystem-import-source-stat'
import { detectImageFileSignature, IMAGE_SIGNATURE_BYTES } from '../../image-file-signature'
import type {
  StagedExternalImportEntry,
  StagedExternalImportSource
} from '../../../shared/filesystem-import-result-types'

class RuntimeUploadSymlinkError extends Error {}

/** Bytes this source contributes to the drop budget; 0 unless it staged. */
export function stagedRuntimeUploadByteLength(source: StagedExternalImportSource): number {
  if (source.status !== 'staged') {
    return 0
  }
  return source.entries.reduce(
    (total, entry) => (entry.kind === 'file' ? total + entry.byteLength : total),
    0
  )
}

/** @param totalBytesBefore Earlier staged bytes in this drop; the ceiling spans all sources.
 * @param options.nameExtensionlessImages Append a sniffed image suffix only in Orca-owned destinations. */
export async function stageOneSourceForRuntimeUpload(
  sourcePath: string,
  totalBytesBefore = 0,
  options: { nameExtensionlessImages?: boolean } = {}
): Promise<StagedExternalImportSource> {
  const resolvedSource = resolve(sourcePath)

  const classified = await classifyImportSource(sourcePath, resolvedSource)
  if ('rejection' in classified) {
    return classified.rejection
  }
  const sourceStat = classified.stat
  const sourceName = basename(resolvedSource)
  try {
    if (sourceStat.isDirectory()) {
      return {
        sourcePath,
        status: 'staged',
        name: sourceName,
        kind: 'directory',
        entries: await stageDirectoryEntries(resolvedSource, totalBytesBefore)
      }
    }
    const staged = await stageFileEntry(resolvedSource, '', {
      totalBytesBefore,
      detectImageExtension: options.nameExtensionlessImages === true && extname(sourceName) === ''
    })
    return {
      sourcePath,
      status: 'staged',
      // Extensionless drag images need a suffix for agents to recognize their format.
      name: staged.imageExtension ? `${sourceName}.${staged.imageExtension}` : sourceName,
      kind: 'file',
      entries: [staged.entry]
    }
  } catch (error) {
    if (error instanceof RuntimeUploadSymlinkError) {
      return { sourcePath, status: 'skipped', reason: 'symlink' }
    }
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

async function stageDirectoryEntries(
  rootPath: string,
  totalBytesBefore: number
): Promise<StagedExternalImportEntry[]> {
  const entries: StagedExternalImportEntry[] = [{ relativePath: '', kind: 'directory' }]
  let totalBytes = totalBytesBefore
  const rootRealPath = await realpath(rootPath)

  async function visit(dirPath: string): Promise<void> {
    const dirStat = await lstat(dirPath)
    if (dirStat.isSymbolicLink()) {
      throw new RuntimeUploadSymlinkError(
        `Symlink not allowed in '${normalizeRelativeUploadPath(relative(rootPath, dirPath))}'`
      )
    }
    if (!dirStat.isDirectory()) {
      throw new Error(
        `Unsupported file type in '${normalizeRelativeUploadPath(relative(rootPath, dirPath))}'`
      )
    }
    await assertRealPathInsideRoot(
      rootRealPath,
      dirPath,
      normalizeRelativeUploadPath(relative(rootPath, dirPath))
    )
    const dirEntries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of dirEntries) {
      const childPath = join(dirPath, entry.name)
      const childRelativePath = normalizeRelativeUploadPath(relative(rootPath, childPath))
      if (entry.isSymbolicLink()) {
        throw new RuntimeUploadSymlinkError(`Symlink not allowed in '${childRelativePath}'`)
      }
      if (entry.isDirectory()) {
        entries.push({ relativePath: childRelativePath, kind: 'directory' })
        await visit(childPath)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported file type in '${childRelativePath}'`)
      }
      const stagedFile = await stageFileEntry(childPath, childRelativePath, {
        rootRealPath,
        totalBytesBefore: totalBytes
      })
      totalBytes += stagedFile.byteLength
      entries.push(stagedFile.entry)
    }
  }

  await visit(rootPath)
  return entries
}

async function stageFileEntry(
  filePath: string,
  relativePath: string,
  options: { rootRealPath?: string; totalBytesBefore: number; detectImageExtension?: boolean }
): Promise<{ entry: StagedExternalImportEntry; byteLength: number; imageExtension?: string }> {
  const statResult = await lstat(filePath)
  const displayPath = normalizeRelativeUploadPath(relativePath)
  // Keep the empty relative path in entries, but name the dropped file in errors.
  const displayName = displayPath || basename(filePath)
  if (statResult.isSymbolicLink()) {
    throw new RuntimeUploadSymlinkError(`Symlink not allowed in '${displayName}'`)
  }
  if (!statResult.isFile()) {
    throw new Error(`Unsupported file type in '${displayName}'`)
  }
  if (options.rootRealPath) {
    await assertRealPathInsideRoot(options.rootRealPath, filePath, displayName)
  }
  assertRemoteUploadBudget(displayName, statResult.size, options.totalBytesBefore + statResult.size)
  const fileHandle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await fileHandle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`Unsupported file type in '${displayName}'`)
    }
    if (
      openedStat.size !== statResult.size ||
      (statResult.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== statResult.ino) ||
      (statResult.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== statResult.dev)
    ) {
      throw new Error(`File changed during upload staging: '${displayName}'`)
    }
    assertRemoteUploadBudget(
      displayName,
      openedStat.size,
      options.totalBytesBefore + openedStat.size
    )
    // Record identity for upload-time checks; size alone cannot detect same-size replacements.
    return {
      entry: {
        relativePath: displayPath,
        kind: 'file',
        byteLength: openedStat.size,
        inode: openedStat.ino,
        deviceId: openedStat.dev,
        modifiedAtMs: openedStat.mtimeMs
      },
      byteLength: openedStat.size,
      imageExtension: options.detectImageExtension
        ? await readImageExtension(fileHandle)
        : undefined
    }
  } finally {
    await fileHandle.close()
  }
}

async function readImageExtension(fileHandle: FileHandle): Promise<string | undefined> {
  const header = Buffer.alloc(IMAGE_SIGNATURE_BYTES)
  const { bytesRead } = await fileHandle.read(header, 0, IMAGE_SIGNATURE_BYTES, 0)
  return detectImageFileSignature(header.subarray(0, bytesRead))?.extension
}

async function assertRealPathInsideRoot(
  rootRealPath: string,
  candidatePath: string,
  displayPath: string
): Promise<void> {
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  // ..name is valid; only .. and ../ paths escape.
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
    throw new Error(`Path escaped upload root during staging: '${displayPath}'`)
  }
}

function assertRemoteUploadBudget(
  displayName: string,
  fileBytes: number,
  totalBytes: number
): void {
  if (fileBytes > REMOTE_IMPORT_MAX_FILE_BYTES) {
    throw new Error(
      `'${displayName}' is ${formatByteCeiling(fileBytes)}, over the ` +
        `${formatByteCeiling(REMOTE_IMPORT_MAX_FILE_BYTES)} per-file remote import limit`
    )
  }
  if (totalBytes > REMOTE_IMPORT_MAX_TOTAL_BYTES) {
    throw new Error(
      `This import is ${formatByteCeiling(totalBytes)}, over the ` +
        `${formatByteCeiling(REMOTE_IMPORT_MAX_TOTAL_BYTES)} total remote import limit`
    )
  }
}

function normalizeRelativeUploadPath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}
