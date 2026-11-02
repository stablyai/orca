import { homedir, userInfo } from 'node:os'
import { mergePersistedWindowsPath } from '../pty/windows-environment-path'
import {
  readGuestWindowsDriveMounts,
  withoutWindowsDriveMountDirs
} from './wsl-guest-windows-drive-path'

// Why (#23214): AppImage and other desktop launches can strip PATH and HOME from
// the process environment. Probes then ENOENT into "not installed", and gh/git
// lose the user's credentials without HOME. These are floors for missing values
// only — an inherited value is never overridden.
const POSIX_FALLBACK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// Why userInfo().homedir and not os.homedir(): os.homedir() answers a *set* HOME
// verbatim, including the empty string, so a set-but-empty HOME would floor to
// itself (a no-op that leaves gh resolving config relative to the cwd).
// userInfo() reads the passwd entry directly and ignores the environment; it can
// throw on a uid with no passwd entry (mapped docker --user), where homedir()
// is the best remaining answer.
function passwdBackedHome(): string {
  try {
    return userInfo().homedir || homedir()
  } catch {
    return homedir()
  }
}

function stringOnlyProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

export function buildLocalPreflightEnv(
  guestWindowsDriveMounts: readonly string[] = readGuestWindowsDriveMounts()
): Record<string, string> | undefined {
  if (process.platform !== 'win32') {
    const env = stringOnlyProcessEnv(process.env)
    let changed = false
    // #23214: AppImage and other desktop launches can strip PATH and HOME; floor
    // missing values only — an inherited value is never overridden.
    if (!env.HOME) {
      env.HOME = passwdBackedHome()
      changed = true
    }
    if (!env.PATH) {
      env.PATH = POSIX_FALLBACK_PATH
      changed = true
    }
    // In a WSL guest, detection must find the Linux CLI, not a Windows shim on /mnt/<drive>.
    if (guestWindowsDriveMounts.length > 0) {
      env.PATH = withoutWindowsDriveMountDirs(env.PATH ?? '', guestWindowsDriveMounts)
      changed = true
    }
    return changed ? env : undefined
  }
  const env = stringOnlyProcessEnv(process.env)
  // The running app must merge persisted Windows PATH to see newly installed CLIs.
  mergePersistedWindowsPath(env)
  return env
}
