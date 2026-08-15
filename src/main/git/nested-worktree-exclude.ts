import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, posix, win32 } from 'path'
import type { IGitProvider, IFilesystemProvider } from '../providers/types'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { gitExecFileAsync } from './runner'
import type { GitWorktreeExecOptions } from './worktree'

const NESTED_WORKTREE_EXCLUDE_PATTERN = '.worktrees/'

type PathOps = Pick<typeof posix, 'isAbsolute' | 'join' | 'normalize'>

/**
 * Ensure a local repo's `.git/info/exclude` ignores the nested `.worktrees/`
 * root, appending the pattern only when it is not already present.
 */
export async function ensureLocalNestedWorktreeRootIgnored(
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const excludePath = await resolveLocalGitExcludePath(repoPath, options)
  const nextContent = await readExcludeWithPattern(excludePath, (path) =>
    readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return ''
      }
      throw error
    })
  )
  if (nextContent === null) {
    return
  }
  await mkdir(dirname(excludePath), { recursive: true })
  await writeFile(excludePath, nextContent, 'utf8')
}

/**
 * Remote-host counterpart of {@link ensureLocalNestedWorktreeRootIgnored},
 * operating over the SSH git/filesystem providers.
 */
export async function ensureRemoteNestedWorktreeRootIgnored(
  repoPath: string,
  gitProvider: Pick<IGitProvider, 'exec'>,
  fsProvider: Pick<IFilesystemProvider, 'readFile' | 'writeFile'>
): Promise<void> {
  const excludePath = await resolveRemoteGitExcludePath(repoPath, gitProvider)
  const nextContent = await readExcludeWithPattern(excludePath, async (path) => {
    try {
      return (await fsProvider.readFile(path)).content
    } catch (error) {
      // Why: only a missing file means "no exclude yet". Swallowing every error
      // (e.g. a transient read failure) would overwrite an existing exclude.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return ''
      }
      throw error
    }
  })
  if (nextContent === null) {
    return
  }
  await fsProvider.writeFile(excludePath, nextContent)
}

async function resolveLocalGitExcludePath(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--git-path', 'info/exclude'], {
    cwd: repoPath,
    ...options
  })
  return resolveGitPath(repoPath, stdout.trim())
}

async function resolveRemoteGitExcludePath(
  repoPath: string,
  gitProvider: Pick<IGitProvider, 'exec'>
): Promise<string> {
  const { stdout } = await gitProvider.exec(['rev-parse', '--git-path', 'info/exclude'], repoPath)
  return resolveGitPath(repoPath, stdout.trim())
}

async function readExcludeWithPattern(
  excludePath: string,
  read: (path: string) => Promise<string>
): Promise<string | null> {
  const content = await read(excludePath)
  const lines = content.split(/\r?\n/)
  if (lines.some((line) => line.trim() === NESTED_WORKTREE_EXCLUDE_PATTERN)) {
    return null
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
  return `${content}${prefix}${NESTED_WORKTREE_EXCLUDE_PATTERN}\n`
}

function resolveGitPath(repoPath: string, gitPath: string): string {
  const wsl = parseWslPath(repoPath)
  const normalizedGitPath =
    wsl && gitPath.startsWith('/') ? toWindowsWslPath(gitPath, wsl.distro) : gitPath
  const pathOps = getPathOps(repoPath, normalizedGitPath)
  return pathOps.isAbsolute(normalizedGitPath)
    ? pathOps.normalize(normalizedGitPath)
    : pathOps.join(repoPath, normalizedGitPath)
}

function getPathOps(repoPath: string, gitPath: string): PathOps {
  return looksLikeWindowsPath(repoPath) || looksLikeWindowsPath(gitPath) ? win32 : posix
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\') || pathValue.startsWith('//')
  )
}
