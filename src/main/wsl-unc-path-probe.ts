import { execFileSync } from 'node:child_process'
import { parseWslUncPath } from '../shared/wsl-paths'

/**
 * Check whether a WSL UNC working directory exists by testing it inside the
 * distro itself, returning null when the answer can't be determined.
 *
 * Why: Win32 fs.statSync against the WSL 9P filesystem (\\wsl.localhost\...)
 * is unreliable for repos that live on the WSL side — it can report ENOENT for
 * directories that exist, which made opening a WSL worktree fail with
 * "Working directory ... does not exist". `wsl.exe -d <distro> test -d` asks
 * the distro directly, which is the authoritative answer. Returns null (rather
 * than false) when wsl.exe is unavailable or errors so callers can fall back to
 * the fs check instead of falsely rejecting a valid directory.
 */
export function wslUncDirectoryExists(uncPath: string): boolean | null {
  return wslUncPathExists(uncPath, '-d')
}

/**
 * File twin of `wslUncDirectoryExists`, with the same inconclusive-null contract.
 *
 * Why: the same 9P blindness hits regular files, and a spurious ENOENT on a file
 * that is about to be rewritten read-modify-write would erase its real contents.
 */
export function wslUncFileExists(uncPath: string): boolean | null {
  return wslUncPathExists(uncPath, '-f')
}

function wslUncPathExists(uncPath: string, testFlag: '-d' | '-f'): boolean | null {
  if (process.platform !== 'win32') {
    return null
  }
  const info = parseWslUncPath(uncPath)
  if (!info) {
    return null
  }
  try {
    execFileSync('wsl.exe', ['-d', info.distro, '--', 'test', testFlag, info.linuxPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    })
    return true
  } catch (error) {
    // A non-zero exit (path missing) surfaces as an error with a numeric
    // `status`; treat that as a definitive "does not exist". Any other failure
    // (wsl.exe missing, distro not running, timeout) is inconclusive -> null.
    if (typeof (error as { status?: unknown })?.status === 'number') {
      return false
    }
    return null
  }
}
