import { lstat, readdir, readFile } from 'fs/promises'
import { join, posix, relative, win32 } from 'path'
import { shouldExcludeFolderWorkspaceCopyPath } from '../shared/folder-workspace-copy-rules'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { IFilesystemProvider } from './providers/types'
import { SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from './providers/ssh-filesystem-dispatch'
import {
  readLocalFolderCopyIgnorePatterns,
  readRemoteFolderCopyIgnorePatterns
} from './folder-workspace-fork-copy'

const MAX_FOLDER_DIFF_FILE_BYTES = 512 * 1024
const MAX_FOLDER_DIFF_FILES = 2_000

export type FolderWorkspaceForkDiffResult = {
  diff: string
}

type FolderWorkspaceForkDiffDeps = {
  getSshFilesystemProvider: (connectionId: string) => IFilesystemProvider | undefined
}

type FolderFileSnapshot =
  | { exists: false }
  | { exists: true; comparable: false; reason: 'binary-or-large' }
  | { exists: true; comparable: true; content: string }

export async function diffFolderWorkspaceFork(
  args: {
    parentPath: string
    childPath: string
    connectionId?: string | null
  },
  deps: FolderWorkspaceForkDiffDeps
): Promise<FolderWorkspaceForkDiffResult> {
  if (args.connectionId) {
    const provider = deps.getSshFilesystemProvider(args.connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    return diffRemoteFolderWorkspaceFork(provider, args.parentPath, args.childPath)
  }
  return diffLocalFolderWorkspaceFork(args.parentPath, args.childPath)
}

async function diffLocalFolderWorkspaceFork(
  parentPath: string,
  childPath: string
): Promise<FolderWorkspaceForkDiffResult> {
  const ignorePatterns = await readLocalFolderCopyIgnorePatterns(parentPath)
  const [parentFiles, childFiles] = await Promise.all([
    listLocalComparableFiles(parentPath, ignorePatterns),
    listLocalComparableFiles(childPath, ignorePatterns)
  ])
  return buildFolderDiff(
    parentPath,
    childPath,
    [...parentFiles, ...childFiles],
    async (rootPath, relativePath) => readLocalSnapshot(rootPath, relativePath)
  )
}

async function diffRemoteFolderWorkspaceFork(
  provider: IFilesystemProvider,
  parentPath: string,
  childPath: string
): Promise<FolderWorkspaceForkDiffResult> {
  const ignorePatterns = await readRemoteFolderCopyIgnorePatterns(provider, parentPath)
  const [parentFiles, childFiles] = await Promise.all([
    listRemoteComparableFiles(provider, parentPath, ignorePatterns),
    listRemoteComparableFiles(provider, childPath, ignorePatterns)
  ])
  return buildFolderDiff(
    parentPath,
    childPath,
    [...parentFiles, ...childFiles],
    async (rootPath, relativePath) => readRemoteSnapshot(provider, rootPath, relativePath)
  )
}

async function buildFolderDiff(
  parentPath: string,
  childPath: string,
  candidatePaths: string[],
  readSnapshot: (rootPath: string, relativePath: string) => Promise<FolderFileSnapshot>
): Promise<FolderWorkspaceForkDiffResult> {
  const relativePaths = [...new Set(candidatePaths)].sort((a, b) => a.localeCompare(b))
  if (relativePaths.length > MAX_FOLDER_DIFF_FILES) {
    throw new Error(`folder_diff_file_limit_exceeded:${relativePaths.length}`)
  }
  const sections: string[] = []
  for (const relativePath of relativePaths) {
    const [parent, child] = await Promise.all([
      readSnapshot(parentPath, relativePath),
      readSnapshot(childPath, relativePath)
    ])
    const section = formatFolderFileDiff(relativePath, parent, child)
    if (section) {
      sections.push(section)
    }
  }
  return { diff: sections.join('\n') }
}

async function listLocalComparableFiles(
  rootPath: string,
  ignorePatterns: readonly string[]
): Promise<string[]> {
  const files: string[] = []
  async function walk(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = join(dirPath, entry.name)
      const relativePath = normalizeRelativePath(relative(rootPath, absolutePath))
      if (!relativePath) {
        continue
      }
      const stats = await lstat(absolutePath)
      const isDirectory = stats.isDirectory()
      if (
        shouldExcludeFolderWorkspaceCopyPath({
          relativePath,
          isDirectory,
          ignorePatterns
        })
      ) {
        continue
      }
      if (isDirectory) {
        await walk(absolutePath)
      } else if (stats.isFile()) {
        files.push(relativePath)
      }
    }
  }
  await walk(rootPath)
  return files
}

async function listRemoteComparableFiles(
  provider: IFilesystemProvider,
  rootPath: string,
  ignorePatterns: readonly string[]
): Promise<string[]> {
  const files = await provider.listFiles(rootPath)
  return files.map(normalizeRelativePath).filter(
    (relativePath) =>
      relativePath &&
      !shouldExcludeFolderWorkspaceCopyPath({
        relativePath,
        isDirectory: false,
        ignorePatterns
      })
  )
}

async function readLocalSnapshot(
  rootPath: string,
  relativePath: string
): Promise<FolderFileSnapshot> {
  const filePath = runtimeJoin(rootPath, relativePath)
  try {
    const stats = await lstat(filePath)
    if (!stats.isFile()) {
      return { exists: false }
    }
    if (stats.size > MAX_FOLDER_DIFF_FILE_BYTES) {
      return { exists: true, comparable: false, reason: 'binary-or-large' }
    }
    const buffer = await readFile(filePath)
    if (buffer.includes(0)) {
      return { exists: true, comparable: false, reason: 'binary-or-large' }
    }
    return { exists: true, comparable: true, content: buffer.toString('utf8') }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { exists: false }
    }
    throw error
  }
}

async function readRemoteSnapshot(
  provider: IFilesystemProvider,
  rootPath: string,
  relativePath: string
): Promise<FolderFileSnapshot> {
  const filePath = runtimeJoin(rootPath, relativePath)
  try {
    const stats = await provider.stat(filePath)
    if (stats.type !== 'file') {
      return { exists: false }
    }
    if (stats.size > MAX_FOLDER_DIFF_FILE_BYTES) {
      return { exists: true, comparable: false, reason: 'binary-or-large' }
    }
    const file = await provider.readFile(filePath)
    if (file.isBinary) {
      return { exists: true, comparable: false, reason: 'binary-or-large' }
    }
    return { exists: true, comparable: true, content: file.content }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { exists: false }
    }
    throw error
  }
}

function formatFolderFileDiff(
  relativePath: string,
  parent: FolderFileSnapshot,
  child: FolderFileSnapshot
): string | null {
  if (!parent.exists && !child.exists) {
    return null
  }
  if (parent.exists && child.exists && !parent.comparable && !child.comparable) {
    return null
  }
  if (parent.exists && child.exists && parent.comparable && child.comparable) {
    if (parent.content === child.content) {
      return null
    }
    return formatTextDiff(relativePath, parent.content, child.content, true, true)
  }
  if (parent.exists && child.exists) {
    return formatBinaryDiff(relativePath)
  }
  if (!parent.exists && child.exists) {
    return child.comparable
      ? formatTextDiff(relativePath, '', child.content, false, true)
      : formatBinaryDiff(relativePath)
  }
  if (parent.exists && !child.exists) {
    return parent.comparable
      ? formatTextDiff(relativePath, parent.content, '', true, false)
      : formatBinaryDiff(relativePath)
  }
  return null
}

function formatTextDiff(
  relativePath: string,
  parentContent: string,
  childContent: string,
  parentExists: boolean,
  childExists: boolean
): string {
  const parentLines = splitDiffLines(parentContent)
  const childLines = splitDiffLines(childContent)
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    parentExists ? `--- a/${relativePath}` : '--- /dev/null',
    childExists ? `+++ b/${relativePath}` : '+++ /dev/null',
    `@@ -${formatRange(parentLines.length)} +${formatRange(childLines.length)} @@`,
    ...parentLines.map((line) => `-${line}`),
    ...childLines.map((line) => `+${line}`)
  ].join('\n')
}

function formatBinaryDiff(relativePath: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `Binary files a/${relativePath} and b/${relativePath} differ`
  ].join('\n')
}

function splitDiffLines(content: string): string[] {
  if (!content) {
    return []
  }
  const normalized = content.replace(/\r\n/g, '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
}

function formatRange(lineCount: number): string {
  return lineCount === 0 ? '0,0' : `1,${lineCount}`
}

function runtimeJoin(rootPath: string, relativePath: string): string {
  const pathOps = runtimePathOps(rootPath)
  return relativePath
    .split('/')
    .reduce((parent, segment) => pathOps.join(parent, segment), rootPath)
}

function runtimePathOps(path: string): Pick<typeof posix, 'join'> {
  return isWindowsAbsolutePathLike(path) || path.includes('\\') ? win32 : posix
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true
  }
  return error instanceof Error && /ENOENT|ENOTDIR/.test(error.message)
}
