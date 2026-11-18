/**
 * A repo saved under a mapped drive usually runs Git for Windows, so its linked worktrees' links
 * (`.git` files, `.git/worktrees/<name>/gitdir`) hold `W:/…` paths. The host's Linux Git can't
 * follow those, and its `git worktree prune` would delete their records, so such a repo stays here
 * (the opposite of wsl-drive-project-windows-git's `wsl-authored-worktrees`). Fails closed: only a
 * folder with no Git at all passes without reading its records.
 */
import type { Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { toWindowsWslUncPath } from '../../../../shared/file-access/wsl-paths'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  toWslDistroUncPath,
  wslMappedDriveOf,
  type WslMappedDrive
} from '../../../../shared/wsl-move/wsl-mapped-drive-paths'
import { isForeignLink } from '../../../git/worktrees/removal/worktree-prune-guard'
import { isLocalWslMoveRow } from '../quiescence/wsl-move-scope-guard'
import type { WslMoveScopeRefusal } from './wsl-move-scope'

export type WslMoveWindowsGitVerdict =
  | 'ok'
  /** Worktree records (live or stale) whose links Git for Windows wrote. */
  | 'windows-git-worktrees'
  /** Its own `.git` file names a Windows path: a Git for Windows worktree or `--separate-git-dir`. */
  | 'windows-git-dir'

// Long enough for a cold distro share; a repo whose records don't answer by then stays here.
const GIT_RECORDS_TIMEOUT_MS = 5_000

// Records read at once: enough for many worktrees, few enough not to flood a slow share.
const RECORD_READS_AT_ONCE = 8

const isWindowsLink = (link: string): boolean => isForeignLink(link, true)

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

/** A worktree record's link; null for an entry Git itself ignores or prunes (no `gitdir`). */
async function recordLink(entry: string, signal: AbortSignal | undefined): Promise<string | null> {
  try {
    return (await readFile(join(entry, 'gitdir'), { encoding: 'utf8', signal })).trim()
  } catch (error) {
    // A stray file in `worktrees/` (ENOTDIR) or an entry with no `gitdir` (ENOENT).
    if (isMissing(error) || errorCode(error) === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

async function statOrNull(path: string): Promise<Stats | null> {
  return stat(path).catch((error: unknown) => {
    if (isMissing(error)) {
      return null
    }
    throw error
  })
}

/** A path Git wrote, as this process reads it: Linux paths through the distro's share. */
function readable(base: string, link: string, distro: string): string {
  return link.startsWith('/') ? toWindowsWslUncPath(link, distro) : resolve(base, link)
}

/** The repo's common Git directory, null outside Git, or the Windows-link verdict. */
async function commonDirOf(
  repoPath: string,
  distro: string,
  signal: AbortSignal | undefined
): Promise<{ commonDir: string } | null | 'windows-git-dir'> {
  const dotGit = join(repoPath, '.git')
  const info = await statOrNull(dotGit)
  if (!info) {
    const bare =
      (await statOrNull(join(repoPath, 'HEAD'))) && (await statOrNull(join(repoPath, 'objects')))
    return bare ? { commonDir: repoPath } : null
  }
  if (info.isDirectory()) {
    return { commonDir: dotGit }
  }
  const link = /^gitdir:\s*(.+)$/m
    .exec(await readFile(dotGit, { encoding: 'utf8', signal }))?.[1]
    ?.trim()
  if (!link) {
    throw new Error('git_link_unreadable')
  }
  if (isWindowsLink(link)) {
    return 'windows-git-dir'
  }
  const gitDir = readable(repoPath, link, distro)
  const common = await readFile(join(gitDir, 'commondir'), { encoding: 'utf8', signal }).then(
    (text) => text.trim(),
    (error: unknown) => {
      // No `commondir`: a separate Git folder, which is its own common directory.
      if (isMissing(error)) {
        return ''
      }
      throw error
    }
  )
  if (common && isWindowsLink(common)) {
    return 'windows-git-dir'
  }
  return { commonDir: common ? readable(gitDir, common, distro) : gitDir }
}

/** `repoPath` in a spelling this process reads (the share's, for a mapped drive). */
export async function windowsGitWorktreeVerdict(
  repoPath: string,
  distro: string,
  /** Aborted at the check's timeout: pending reads stop, and no further one starts. */
  signal?: AbortSignal
): Promise<WslMoveWindowsGitVerdict> {
  const found = await commonDirOf(repoPath, distro, signal)
  signal?.throwIfAborted()
  if (found === null || found === 'windows-git-dir') {
    return found ?? 'ok'
  }
  const admin = join(found.commonDir, 'worktrees')
  const entries = await readdir(admin).catch((error: unknown) => {
    if (isMissing(error)) {
      return []
    }
    throw error
  })
  for (let start = 0; start < entries.length; start += RECORD_READS_AT_ONCE) {
    signal?.throwIfAborted()
    // An unreadable record fails the check: it may be one the host's prune would delete.
    const links = await Promise.all(
      entries
        .slice(start, start + RECORD_READS_AT_ONCE)
        .map((entry) => recordLink(join(admin, entry), signal))
    )
    if (links.some((link) => link !== null && isWindowsLink(link))) {
      return 'windows-git-worktrees'
    }
  }
  return 'ok'
}

/** Stops waiting at the timeout, and aborts the reads that support it; a hung stat is left. */
async function verdictWithin(
  check: (signal: AbortSignal) => Promise<WslMoveWindowsGitVerdict>,
  timeoutMs: number
): Promise<WslMoveWindowsGitVerdict | 'git-unreadable'> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'git-unreadable'>((done) => {
    timer = setTimeout(() => {
      controller.abort()
      done('git-unreadable')
    }, timeoutMs)
  })
  const verdict = check(controller.signal).catch((): 'git-unreadable' => 'git-unreadable')
  return Promise.race([verdict, timeout]).finally(() => clearTimeout(timer))
}

/** The local mapped-drive repos the host's Git can't take, each with why; read via the share. */
export async function findWindowsGitRefusals(
  repos: readonly Repo[],
  distro: string,
  mappedDrives: readonly WslMappedDrive[],
  check: (
    readablePath: string,
    distro: string,
    signal: AbortSignal
  ) => Promise<WslMoveWindowsGitVerdict>,
  timeoutMs = GIT_RECORDS_TIMEOUT_MS
): Promise<Map<string, WslMoveScopeRefusal>> {
  const onMappedDrive = repos.filter(
    (repo) => isLocalWslMoveRow(repo) && wslMappedDriveOf(repo.path, mappedDrives) !== null
  )
  const verdicts = await Promise.all(
    onMappedDrive.map(async (repo) => {
      const sharePath = toWslDistroUncPath(repo.path, mappedDrives)
      return [
        repo.id,
        await verdictWithin((signal) => check(sharePath, distro, signal), timeoutMs)
      ] as const
    })
  )
  const refusals = new Map<string, WslMoveScopeRefusal>()
  for (const [id, verdict] of verdicts) {
    if (verdict !== 'ok') {
      refusals.set(id, verdict)
    }
  }
  return refusals
}
