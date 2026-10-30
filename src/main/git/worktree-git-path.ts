/**
 * `git rev-parse --git-path <relative>` for a per-worktree file, read from the worktree's own `.git`
 * instead of running Git: the setup runner needs it synchronously, and a synchronous Git in a WSL
 * project would be a synchronous wsl.exe on the main thread. Null when the link isn't one this can
 * read, so the caller falls back to Git.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { wslDrivePathUnderRoots } from '../wsl/wsl-automount-root'

// Git keeps these per worktree; everything else under the git dir (`hooks/`, `info/`, `objects/`,
// `refs/`, `config`, `packed-refs`, …) lives in the common dir, which only real Git resolves.
const PER_WORKTREE_ENTRIES: ReadonlySet<string> = new Set([
  'orca',
  'HEAD',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'index',
  'logs'
])

export function readWorktreeGitPath(
  worktreePath: string,
  relativePath: string,
  automountRoots: readonly string[],
  isDirectory: (path: string) => boolean = directoryExists
): string | null {
  if (!PER_WORKTREE_ENTRIES.has(relativePath.split('/')[0] ?? '')) {
    return null
  }
  const gitdir = readGitDir(worktreePath, automountRoots)
  // A stale or pruned link: real Git reports it, where a write here would recreate half of it.
  if (!gitdir || !isDirectory(gitdir)) {
    return null
  }
  // A drive or UNC git dir keeps Windows separators wherever this runs.
  const joinPath = /^([A-Za-z]:|[\\/]{2})/.test(gitdir) ? win32.join : join
  return joinPath(gitdir, ...relativePath.split('/'))
}

function readGitDir(worktreePath: string, automountRoots: readonly string[]): string | null {
  const dotGit = join(worktreePath, '.git')
  let link: string
  try {
    if (statSync(dotGit).isDirectory()) {
      return dotGit
    }
    link = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim() ?? ''
  } catch {
    return null
  }
  if (!link) {
    return null
  }
  if (!/^[\\/]/.test(link) || /^[\\/]{2}/.test(link)) {
    // A drive path, a UNC path, or one relative to the worktree.
    return /^[A-Za-z]:[\\/]/.test(link) ? win32.normalize(link) : resolve(worktreePath, link)
  }
  // WSL Git wrote the distro's view: a drive under its mount root, or a folder inside the distro.
  const drive = wslDrivePathUnderRoots(link, automountRoots)
  if (drive) {
    return drive
  }
  const distro = parseWslUncPath(worktreePath)?.distro
  return distro ? toWindowsWslUncPath(link, distro) : null
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
