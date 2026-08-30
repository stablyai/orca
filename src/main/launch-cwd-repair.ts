import { statSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * Keep the process out of a working directory that can be deleted under it.
 *
 * Why: a process inherits its launcher's directory, and on Windows every later
 * spawn hands that directory to `CreateProcessW` as `lpCurrentDirectory` when
 * the caller passes no explicit `cwd`. Win32 holds an open handle on a local
 * cwd, so a native directory cannot vanish underneath it — but a UNC share is
 * not covered by that lock. The WSL 9P share (`\\wsl.localhost\<distro>\...`)
 * is the case that reached users: `rm -rf` inside the distro removes the
 * directory anyway, Orca's own `git worktree remove` included.
 * `process.cwd()` keeps reporting the dead path, so the process cannot notice;
 * `CreateProcessW` then fails with `ERROR_PATH_NOT_FOUND`, libuv maps it to
 * `ENOENT` against the *executable* name, and every spawn for the rest of the
 * session reads as `spawn wsl.exe ENOENT` (issue #16463).
 *
 * The repair is a relocation, never a refusal: nothing in Orca resolves a
 * user-facing path against the process cwd (the CLI carries the caller's
 * directory in `ORCA_CLI_CWD`, and every execution host is addressed by an
 * explicit absolute path), so standing somewhere stable costs nothing.
 */

/**
 * A Windows path served over the network rather than by a local volume.
 *
 * Extended (`\\?\C:\...`) and device (`\\.\...`) prefixes are excluded: they
 * share the leading pair but name a local object, which Win32 does lock.
 */
function isUncSharePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  // Extended-length UNC paths still refer to a network share; only extended
  // local (`\\?\C:`) and device paths are safe to keep as a process cwd.
  if (normalized.toLowerCase().startsWith('//?/unc/')) {
    return true
  }
  return normalized.startsWith('//') && !/^\/\/[?.]\//.test(normalized)
}

/** Why the cwd had to be abandoned. */
export type LaunchCwdRepairReason =
  /** The directory is gone, or `process.cwd()` itself failed. */
  | 'unresolvable'
  /** A UNC share: still readable now, but deletable out from under us. */
  | 'network-share'

export type LaunchCwdRepair =
  | { outcome: 'kept'; cwd: string }
  | { outcome: 'relocated'; from: string | null; to: string; reason: LaunchCwdRepairReason }
  | { outcome: 'unrepaired'; from: string | null; reason: LaunchCwdRepairReason }

export type LaunchCwdRepairDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  readCwd?: () => string
  isDirectory?: (path: string) => boolean
  chdir?: (path: string) => void
  homeDirectory?: () => string
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readHomeDirectory(): string {
  try {
    return homedir()
  } catch {
    return ''
  }
}

/**
 * Directories the process may stand in, best first.
 *
 * userData leads because it is the one directory Orca creates and never
 * removes; the home and drive roots are there for a stripped environment where
 * it is somehow absent.
 */
export function stableCwdCandidates(deps: LaunchCwdRepairDeps = {}): string[] {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const home = (deps.homeDirectory ?? readHomeDirectory)()
  const homeDrive = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined
  const candidates =
    platform === 'win32'
      ? [
          env.ORCA_USER_DATA_PATH,
          env.LOCALAPPDATA,
          env.USERPROFILE,
          homeDrive,
          home,
          env.SystemDrive ? `${env.SystemDrive}\\` : 'C:\\'
        ]
      : [env.ORCA_USER_DATA_PATH, env.HOME, home, '/']

  const unique: string[] = []
  for (const candidate of candidates) {
    // Why the share filter: relocating onto another share just re-arms the bug.
    if (!candidate || unique.includes(candidate) || isUncSharePath(candidate)) {
      continue
    }
    unique.push(candidate)
  }
  return unique
}

/**
 * Move off an unusable or unsafe working directory, once, at process start.
 *
 * Proactive rather than on-failure because Windows gives no failure to react
 * to: `process.cwd()` keeps returning a deleted 9P path, and a `stat` against
 * that share answers unreliably even for directories that do exist (see
 * `wslUncDirectoryExists`). The path shape is therefore checked before the
 * filesystem is, so a share cwd is abandoned no matter what the share reports.
 */
export function repairLaunchCwd(deps: LaunchCwdRepairDeps = {}): LaunchCwdRepair {
  const platform = deps.platform ?? process.platform
  const readCwd = deps.readCwd ?? ((): string => process.cwd())
  const isDirectory = deps.isDirectory ?? directoryExists
  const chdir = deps.chdir ?? ((path: string): void => process.chdir(path))

  let cwd: string | null = null
  try {
    cwd = readCwd()
  } catch {
    // POSIX throws here once the directory is unlinked; Windows never does.
  }

  // Why the share test short-circuits the stat: a 9P share answers unreliably in
  // both directions, so the path shape decides before the filesystem is asked.
  const onShare = cwd !== null && platform === 'win32' && isUncSharePath(cwd)
  if (cwd !== null && !onShare && isDirectory(cwd)) {
    return { outcome: 'kept', cwd }
  }
  const reason: LaunchCwdRepairReason = onShare ? 'network-share' : 'unresolvable'

  for (const candidate of stableCwdCandidates({ ...deps, platform })) {
    if (!isDirectory(candidate)) {
      continue
    }
    try {
      chdir(candidate)
      return { outcome: 'relocated', from: cwd, to: candidate, reason }
    } catch {
      // Try the next stable directory.
    }
  }
  return { outcome: 'unrepaired', from: cwd, reason }
}

export function describeLaunchCwdRepair(repair: LaunchCwdRepair): string | null {
  if (repair.outcome === 'kept') {
    return null
  }
  const from = repair.from ?? '<unavailable>'
  return repair.outcome === 'relocated'
    ? `[launch-cwd] left ${repair.reason} working directory ${from} for ${repair.to}`
    : `[launch-cwd] ${repair.reason} working directory ${from} and no stable directory to move to; subprocess spawns may fail`
}
