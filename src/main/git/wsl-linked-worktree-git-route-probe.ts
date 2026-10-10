import * as fsPromises from 'node:fs/promises'
import { win32 } from 'node:path'
import type { Stats } from 'node:fs'

export type WslLinkedWorktreeRoutingFileSystem = {
  stat(path: string): Promise<Pick<Stats, 'isDirectory' | 'isFile'>>
  readFile(path: string): Promise<string>
}

/** `known: false` means the marker exists but cannot be classified — what a half-written `.git` file looks like mid `worktree add`. */
export type WslLinkedWorktreeGitRouteProbeResult = {
  usesHostGit: boolean
  known: boolean
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[/\\]/

function parseLinkedGitdir(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.match(/^gitdir:\s*(\S.*?)\s*$/i)?.[1] ?? null
}

export function parseWindowsLinkedGitdir(content: string): string | null {
  const gitdir = parseLinkedGitdir(content)
  return gitdir !== null && WINDOWS_DRIVE_PATH.test(gitdir) ? gitdir : null
}

export const defaultWslLinkedWorktreeRoutingFileSystem: WslLinkedWorktreeRoutingFileSystem = {
  stat: (path) => fsPromises.stat(path),
  readFile: (path) => fsPromises.readFile(path, 'utf8')
}

/** Walk parent directories until Git's worktree marker identifies which Git owns this checkout. */
export async function probeWslLinkedWorktreeGitRoute(
  cwd: string,
  fileSystem: WslLinkedWorktreeRoutingFileSystem
): Promise<WslLinkedWorktreeGitRouteProbeResult> {
  let candidate = cwd
  const driveRoot = win32.parse(candidate).root
  while (true) {
    const markerPath = win32.join(candidate, '.git')
    try {
      const marker = await fileSystem.stat(markerPath)
      if (!marker.isFile()) {
        // A `.git` directory (or anything that is not a file) is a normal main checkout.
        return { usesHostGit: false, known: true }
      }
      const gitdir = parseLinkedGitdir(await fileSystem.readFile(markerPath))
      // A POSIX gitdir is a settled answer too: the distro owns this checkout.
      return gitdir === null
        ? { usesHostGit: false, known: false }
        : { usesHostGit: WINDOWS_DRIVE_PATH.test(gitdir), known: true }
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : null
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error
      }
    }
    if (candidate === driveRoot) {
      // No marker up to the drive root: not a worktree at all, and stable enough to cache.
      return { usesHostGit: false, known: true }
    }
    candidate = win32.dirname(candidate)
  }
}
