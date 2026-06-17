import { constants } from 'fs'
import { cp, lstat, mkdir, readFile } from 'fs/promises'
import { dirname, join, posix, relative, win32 } from 'path'
import {
  DEFAULT_FOLDER_WORKSPACE_COPY_IGNORE_PATTERNS,
  parseFolderWorkspaceCopyIgnoreFile,
  shouldExcludeFolderWorkspaceCopyPath
} from '../shared/folder-workspace-copy-rules'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { GlobalSettings, Repo } from '../shared/types'
import type { IFilesystemProvider } from './providers/types'
import { SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from './providers/ssh-filesystem-dispatch'
import {
  computeWorktreePath,
  getWorktreePathSettings,
  sanitizeWorktreeName
} from './ipc/worktree-logic'

export type FolderWorkspaceForkCopyResult = {
  destinationPath: string
  ignorePatterns: string[]
}

type FolderWorkspaceForkCopyDeps = {
  getSshFilesystemProvider: (connectionId: string) => IFilesystemProvider | undefined
}

export function resolveFolderWorkspaceForkDestinationPath(args: {
  repo: Repo
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces'>
  name: string
}): string {
  return computeWorktreePath(
    sanitizeWorktreeName(args.name),
    args.repo.path,
    getWorktreePathSettings(args.repo, args.settings)
  )
}

export async function copyFolderWorkspaceForFork(
  args: {
    sourcePath: string
    destinationPath: string
    connectionId?: string | null
  },
  deps: FolderWorkspaceForkCopyDeps
): Promise<FolderWorkspaceForkCopyResult> {
  if (args.connectionId) {
    const provider = deps.getSshFilesystemProvider(args.connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const ignorePatterns = await readRemoteFolderCopyIgnorePatterns(provider, args.sourcePath)
    await provider.createDir(runtimeDirname(args.destinationPath))
    await provider.copy(args.sourcePath, args.destinationPath, { ignorePatterns })
    return { destinationPath: args.destinationPath, ignorePatterns }
  }

  const ignorePatterns = await readLocalFolderCopyIgnorePatterns(args.sourcePath)
  await mkdir(dirname(args.destinationPath), { recursive: true })
  await cp(args.sourcePath, args.destinationPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    mode: constants.COPYFILE_FICLONE,
    filter: async (source) => {
      const relativePath = relative(args.sourcePath, source)
      if (!relativePath) {
        return true
      }
      const stat = await lstat(source)
      return !shouldExcludeFolderWorkspaceCopyPath({
        relativePath,
        isDirectory: stat.isDirectory(),
        ignorePatterns
      })
    }
  })
  return { destinationPath: args.destinationPath, ignorePatterns }
}

export async function readLocalFolderCopyIgnorePatterns(sourcePath: string): Promise<string[]> {
  const patterns = [...DEFAULT_FOLDER_WORKSPACE_COPY_IGNORE_PATTERNS]
  for (const fileName of ['.orcaignore', '.gitignore']) {
    try {
      patterns.push(
        ...parseFolderWorkspaceCopyIgnoreFile(await readFile(join(sourcePath, fileName), 'utf8'))
      )
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
    }
  }
  return patterns
}

export async function readRemoteFolderCopyIgnorePatterns(
  provider: IFilesystemProvider,
  sourcePath: string
): Promise<string[]> {
  const patterns = [...DEFAULT_FOLDER_WORKSPACE_COPY_IGNORE_PATTERNS]
  for (const fileName of ['.orcaignore', '.gitignore']) {
    try {
      const file = await provider.readFile(runtimeJoin(sourcePath, fileName))
      if (!file.isBinary) {
        patterns.push(...parseFolderWorkspaceCopyIgnoreFile(file.content))
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
    }
  }
  return patterns
}

function runtimeJoin(parentPath: string, childName: string): string {
  return runtimePathOps(parentPath).join(parentPath, childName)
}

function runtimeDirname(path: string): string {
  return runtimePathOps(path).dirname(path)
}

function runtimePathOps(path: string): Pick<typeof posix, 'dirname' | 'join'> {
  return isWindowsAbsolutePathLike(path) || path.includes('\\') ? win32 : posix
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true
  }
  return error instanceof Error && /ENOENT|ENOTDIR/.test(error.message)
}
