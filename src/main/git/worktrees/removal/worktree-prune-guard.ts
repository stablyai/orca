// Windows and WSL Git cannot resolve each other’s worktree links; lock foreign entries during prune to preserve their metadata.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  isDrvfsLinuxPath,
  toWindowsWslDrivePath,
  toWindowsWslUncPath,
  wslDistroForCommand
} from '../../../../shared/file-access/wsl-paths'
import type { GitExecOptions } from '../../command-runner/git-exec-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { pendingWslDriveCheckoutGitRouting } from '../../command-runner/host-routing/wsl-drive-checkout-git-routing'
import { usesHostGitForWslLinkedWorktree } from '../../command-runner/host-routing/wsl-linked-worktree-git-routing'
import { getErrorCode } from '../worktree-operation-options'

/** Marks only the locks this module writes, so it never removes a user's own lock. */
export const PRUNE_GUARD_LOCK_REASON =
  'Orca: kept from a prune by the other Git (Windows or WSL), which cannot read this link.'

// One lock-prune-unlock per repo at a time: an overlapping prune would outlive the other's unlock.
const prunesByAdminRoot = new Map<string, Promise<void>>()

export async function pruneGitWorktrees(
  options: GitExecOptions,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'win32') {
    await gitExecFileAsync(['worktree', 'prune'], options)
    return
  }
  // Decide which Git runs only once its routing is settled, as the prune itself will.
  await pendingWslDriveCheckoutGitRouting(['worktree', 'prune'], options)
  const distro = usesHostGitForWslLinkedWorktree(options.cwd, options.wslDistro)
    ? null
    : wslDistroForCommand(options.cwd, options.wslDistro)
  const adminRoot = await worktreeAdminRoot(options, distro)
  const key = adminRoot.toLowerCase()
  const run = (prunesByAdminRoot.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => pruneWithForeignEntriesLocked(options, adminRoot, distro !== null))
  prunesByAdminRoot.set(key, run)
  try {
    await run
  } finally {
    if (prunesByAdminRoot.get(key) === run) {
      prunesByAdminRoot.delete(key)
    }
  }
}

async function pruneWithForeignEntriesLocked(
  options: GitExecOptions,
  adminRoot: string,
  runsInWsl: boolean
): Promise<void> {
  const locked: string[] = []
  try {
    // A record this process cannot read or lock rejects here, before the prune deletes it.
    for (const { entry, link } of await readWorktreeLinks(adminRoot)) {
      if (!isForeignLink(link, runsInWsl)) {
        continue
      }
      const lockFile = join(entry, 'locked')
      const owned = await writeFile(lockFile, PRUNE_GUARD_LOCK_REASON, { flag: 'wx' }).then(
        () => true,
        async (error: unknown) => {
          // An existing lock is the user's, unless a crash left one of ours behind.
          if (getErrorCode(error) !== 'EEXIST') {
            throw error
          }
          return (await readFile(lockFile, 'utf8').catch(() => '')) === PRUNE_GUARD_LOCK_REASON
        }
      )
      if (owned) {
        locked.push(lockFile)
      }
    }
    await gitExecFileAsync(['worktree', 'prune'], options)
  } finally {
    await Promise.all(locked.map((lockFile) => rm(lockFile, { force: true })))
  }
}

/** Admin entries and `gitdir` links; rejects on any unread record, since a prune may delete it. */
export async function readWorktreeLinks(
  adminRoot: string
): Promise<{ entry: string; link: string }[]> {
  const entries = (
    await readdir(adminRoot).catch((error: unknown) => {
      // Only a listable common directory makes a missing folder a repo without linked worktrees.
      if (getErrorCode(error) !== 'ENOENT') {
        throw error
      }
      return readdir(dirname(adminRoot)).then(() => [])
    })
  ).map((name) => join(adminRoot, name))
  const links = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      link: await readFile(join(entry, 'gitdir'), 'utf8').then(
        (text) => text.trim(),
        (error: unknown) => {
          // A stray file, or an entry Git prunes itself, has no link.
          const code = getErrorCode(error)
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return ''
          }
          throw error
        }
      )
    }))
  )
  return links.filter(({ link }) => link)
}

/**
 * Windows Git writes drive paths and `//server/share` paths; WSL Git writes POSIX paths. A
 * relative link (worktree.useRelativePaths) resolves for both.
 */
export function isForeignLink(link: string, runsInWsl: boolean): boolean {
  const windowsLink = /^[A-Za-z]:[\\/]/.test(link) || /^[\\/]{2}/.test(link)
  return runsInWsl ? windowsLink : link.startsWith('/') && !windowsLink
}

/** `<common dir>/worktrees` as this process can read it, also for bare or linked checkouts. */
async function worktreeAdminRoot(options: GitExecOptions, distro: string | null): Promise<string> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--git-common-dir'], options)
  const commonDir = stdout.trim()
  const readable = !commonDir.startsWith('/')
    ? isAbsolute(commonDir)
      ? commonDir
      : join(options.cwd, commonDir)
    : isDrvfsLinuxPath(commonDir)
      ? toWindowsWslDrivePath(commonDir)
      : distro
        ? toWindowsWslUncPath(commonDir, distro)
        : commonDir
  return join(readable ?? commonDir, 'worktrees')
}
