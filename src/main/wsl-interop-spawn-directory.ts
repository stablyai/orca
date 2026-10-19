import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'

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
 *
 * Why a system directory and never the profile or user folder (#29845): WSL
 * holds this directory busy for about its ~60s idle timeout after `wsl.exe`
 * exits, so a profile named here cannot be deleted for a minute after Orca exits.
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
  // Why re-validate: the answer is only useful while it still resolves.
  if (isExistingDirectory(cachedSpawnCwd)) {
    return cachedSpawnCwd
  }
  const env = process.env
  const candidates: (string | undefined)[] = [
    env.SystemRoot,
    env.windir,
    env.SystemDrive ? `${env.SystemDrive}\\` : undefined,
    'C:\\',
    // Why last: unreachable on a real Windows host; it keeps POSIX test hosts naming a directory.
    tmpdir()
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
