import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { authorizeExternalPath } from './filesystem-auth'
import { isENOENT } from './filesystem-path-containment'
import type {
  StagedExternalImportEntry,
  StagedExternalImportSource
} from './filesystem-import-result-types'

const REMOTE_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024
const REMOTE_IMPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024

class RuntimeUploadSymlinkError extends Error {}

export async function stageOneSourceForRuntimeUpload(
  sourcePath: string
): Promise<StagedExternalImportSource> {
  const resolvedSource = resolve(sourcePath)

  // Why: runtime uploads read client-local paths in the client main process;
  // authorize before lstat/readFile just like local copy imports.
  authorizeExternalPath(resolvedSource)

  let sourceStat: Awaited<ReturnType<typeof lstat>>
  try {
    sourceStat = await lstat(resolvedSource)
  } catch (error) {
    if (isENOENT(error)) {
      return { sourcePath, status: 'skipped', reason: 'missing' }
    }
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EACCES' ||
        (error as NodeJS.ErrnoException).code === 'EPERM')
    ) {
      return { sourcePath, status: 'skipped', reason: 'permission-denied' }
    }
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  if (sourceStat.isSymbolicLink()) {
    return { sourcePath, status: 'skipped', reason: 'symlink' }
  }
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    return { sourcePath, status: 'skipped', reason: 'unsupported' }
  }
  try {
    const entries = sourceStat.isDirectory()
      ? await stageDirectoryEntries(resolvedSource)
      : [(await stageFileEntry(resolvedSource, '')).entry]
    return {
      sourcePath,
      status: 'staged',
      name: basename(resolvedSource),
      kind: sourceStat.isDirectory() ? 'directory' : 'file',
      entries
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

async function stageDirectoryEntries(rootPath: string): Promise<StagedExternalImportEntry[]> {
  const entries: StagedExternalImportEntry[] = [{ relativePath: '', kind: 'directory' }]
  let totalBytes = 0
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
  options?: { rootRealPath?: string; totalBytesBefore?: number }
): Promise<{ entry: StagedExternalImportEntry; byteLength: number }> {
  const statResult = await lstat(filePath)
  const displayPath = normalizeRelativeUploadPath(relativePath)
  if (statResult.isSymbolicLink()) {
    throw new RuntimeUploadSymlinkError(`Symlink not allowed in '${displayPath}'`)
  }
  if (!statResult.isFile()) {
    throw new Error(`Unsupported file type in '${displayPath}'`)
  }
  if (options?.rootRealPath) {
    await assertRealPathInsideRoot(options.rootRealPath, filePath, displayPath)
  }
  const initialTotalBytes =
    options?.totalBytesBefore === undefined
      ? statResult.size
      : options.totalBytesBefore + statResult.size
  assertRemoteUploadBudget(relativePath, statResult.size, initialTotalBytes)
  const fileHandle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await fileHandle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`Unsupported file type in '${displayPath}'`)
    }
    if (
      openedStat.size !== statResult.size ||
      (statResult.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== statResult.ino) ||
      (statResult.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== statResult.dev)
    ) {
      throw new Error(`File changed during upload staging: '${displayPath}'`)
    }
    const totalBytes =
      options?.totalBytesBefore === undefined
        ? openedStat.size
        : options.totalBytesBefore + openedStat.size
    assertRemoteUploadBudget(relativePath, openedStat.size, totalBytes)
    const buffer = await fileHandle.readFile()
    const afterReadStat = await fileHandle.stat()
    if (afterReadStat.size !== openedStat.size) {
      throw new Error(`File changed during upload staging: '${displayPath}'`)
    }
    return {
      entry: {
        relativePath: displayPath,
        kind: 'file',
        contentBase64: buffer.toString('base64')
      },
      byteLength: openedStat.size
    }
  } finally {
    await fileHandle.close()
  }
}

async function assertRealPathInsideRoot(
  rootRealPath: string,
  candidatePath: string,
  displayPath: string
): Promise<void> {
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
    throw new Error(`Path escaped upload root during staging: '${displayPath}'`)
  }
}

function assertRemoteUploadBudget(
  relativePath: string,
  fileBytes: number,
  totalBytes: number
): void {
  if (fileBytes > REMOTE_IMPORT_MAX_FILE_BYTES) {
    throw new Error(`'${relativePath}' is too large for remote import`)
  }
  if (totalBytes > REMOTE_IMPORT_MAX_TOTAL_BYTES) {
    throw new Error('Remote import is too large')
  }
}

function normalizeRelativeUploadPath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}
