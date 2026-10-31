import { win32 } from 'node:path'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { knownWslAutomountRoots } from '../wsl/wsl-automount-root'
import { gitExecFileAsync } from './command-runner/git-exec-file'
import { readWorktreeGitPath } from './worktree-git-path'

/**
 * A per-worktree Git path for a worktree inside a distro, as a path Windows can write. Reads the
 * `.git` link first; the distro's own Git answers when that read fails.
 */
export async function resolveWslWorktreeGitPath(
  worktreePath: string,
  relativePath: string
): Promise<string> {
  const read = (): string | null =>
    readWorktreeGitPath(worktreePath, relativePath, knownWslAutomountRoots())
  // A Windows stat over \\wsl.localhost can report a transient ENOENT.
  const fromLink = read() ?? read()
  if (fromLink) {
    return fromLink
  }
  const distro = parseWslUncPath(worktreePath)?.distro
  try {
    // Async and fenced; the caller is a user act, so starting the distro is fine here.
    const { stdout } = await gitExecFileAsync(['rev-parse', '--git-path', relativePath], {
      cwd: worktreePath
    })
    const gitPath = stdout.trim()
    if (gitPath && distro) {
      return gitPath.startsWith('/')
        ? toWindowsWslUncPath(gitPath, distro)
        : win32.join(worktreePath, gitPath)
    }
  } catch (error) {
    throw wslWorktreeGitPathError(worktreePath, error)
  }
  throw wslWorktreeGitPathError(worktreePath)
}

function wslWorktreeGitPathError(worktreePath: string, cause?: unknown): Error {
  return new Error(
    `Orca couldn't find this WSL worktree's Git folder to write its setup script. Check that ${worktreePath} is a Git worktree.`,
    cause === undefined ? undefined : { cause }
  )
}
