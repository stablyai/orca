/**
 * `git worktree prune` deletes the metadata of every linked worktree whose link doesn't resolve.
 * On Windows one repo can hold links written by both Windows Git (`C:/…`) and WSL Git (`/mnt/c/…`,
 * `/home/…`), e.g. after its runtime was switched; each Git reads the other's links as missing.
 * So the other Git's entries are locked for the prune (git never prunes a locked entry), and the
 * rest prune as before.
 */
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  isDrvfsLinuxPath,
  toWindowsWslDrivePath,
  toWindowsWslUncPath
} from '../../shared/wsl-paths'
import type { GitExecOptions } from './command-runner/git-exec-options'
import { wslDistroForCommand } from './command-runner/git-command-resolution'
import { gitExecFileAsync } from './runner'
import { pendingWslDriveCheckoutGitRouting } from './wsl-drive-checkout-git-routing'
import { usesHostGitForWslLinkedWorktree } from './wsl-linked-worktree-git-routing'

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
  const locked = await lockForeignWorktreeEntries(adminRoot, runsInWsl)
  try {
    await gitExecFileAsync(['worktree', 'prune'], options)
  } finally {
    await Promise.all(locked.map((lockFile) => rm(lockFile, { force: true })))
  }
}

/** Returns the lock files this module owns now; an entry the user locked is left alone. */
async function lockForeignWorktreeEntries(
  adminRoot: string,
  runsInWsl: boolean
): Promise<string[]> {
  const locked: string[] = []
  for (const { entry, link } of await readWorktreeLinks(adminRoot)) {
    if (!isForeignLink(link, runsInWsl)) {
      continue
    }
    const lockFile = join(entry, 'locked')
    const owned = await writeFile(lockFile, PRUNE_GUARD_LOCK_REASON, { flag: 'wx' }).then(
      () => true,
      // An existing lock is the user's, unless a crash left one of ours behind.
      async () => (await readFile(lockFile, 'utf8').catch(() => '')) === PRUNE_GUARD_LOCK_REASON
    )
    if (owned) {
      locked.push(lockFile)
    }
  }
  return locked
}

/** Each linked worktree's admin entry and its `gitdir` link; none when the folder is missing. */
export async function readWorktreeLinks(
  adminRoot: string
): Promise<{ entry: string; link: string }[]> {
  const entries = (await readdir(adminRoot).catch(() => [])).map((name) => join(adminRoot, name))
  const links = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      link: await readFile(join(entry, 'gitdir'), 'utf8').then(
        (text) => text.trim(),
        () => ''
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
