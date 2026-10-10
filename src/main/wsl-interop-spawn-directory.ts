import { statSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * A Windows directory that is safe to hand `wsl.exe` as its working directory.
 *
 * Why this exists (#16463): the WSL command builders set `cwd: undefined`,
 * meaning "the directory is already expressed inside the command" — but that is
 * not what `undefined` means to `CreateProcessW`. libuv passes NULL for
 * `lpCurrentDirectory`, and NULL means *inherit the parent's*. Orca launched by
 * `orca-ide` from a WSL shell inherits `\\wsl.localhost\<distro>\...\<worktree>`
 * as its Win32 cwd; Linux can delete that directory out from under a Windows
 * process across the 9P share, and from then on `CreateProcessW` fails
 * `ERROR_PATH_NOT_FOUND` — surfaced by libuv as `spawn wsl.exe ENOENT`, for the
 * rest of the process's life, for every repository.
 *
 * Naming an explicit directory removes the dependency on process-global state
 * entirely, so a repaired or unrepaired `process.cwd()` cannot decide whether
 * git works. It is never the cwd the command runs in: WSL invocations carry
 * their Linux directory in `git -C`, a `cd` inside `bash -c`, or the `sh -c`
 * wrapper `withGuestCwd` builds.
 */

let cachedSpawnCwd: string | null = null

function isExistingDirectory(path: string | undefined | null): path is string {
  if (!path) {
    return false
  }
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Test seam: forget the memoized directory so a later probe re-validates. */
export function resetWslInteropSpawnDirectoryCache(): void {
  cachedSpawnCwd = null
}

export function resolveWslInteropSpawnCwd(): string | undefined {
  // Why re-validate: the answer is only useful while it still resolves, and the
  // user's profile directory can go away on a roaming/mapped-drive host.
  if (isExistingDirectory(cachedSpawnCwd)) {
    return cachedSpawnCwd
  }
  const env = process.env
  // Why this order: an app-owned directory first (it outlives every worktree),
  // then the user's profile, then the system root as a floor that always exists.
  // A root is fine here — nothing scans this directory, it is only the value
  // `CreateProcessW` receives for `lpCurrentDirectory`.
  const candidates: (string | undefined)[] = [
    env.ORCA_USER_DATA_PATH,
    env.USERPROFILE,
    env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined,
    homedir(),
    env.SystemDrive ? `${env.SystemDrive}\\` : 'C:\\'
  ]
  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      cachedSpawnCwd = candidate
      return candidate
    }
  }
  cachedSpawnCwd = null
  // Why undefined rather than a guess: inheriting is still better than naming a
  // directory we just proved does not exist.
  return undefined
}
