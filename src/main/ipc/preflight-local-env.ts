import { homedir, userInfo } from 'node:os'
import { mergePersistedWindowsPath } from '../pty/windows-environment-path'

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

export function buildLocalPreflightEnv(): Record<string, string> | undefined {
  if (process.platform !== 'win32') {
    const env = stringOnlyProcessEnv(process.env)
    let floored = false
    if (!env.HOME) {
      env.HOME = passwdBackedHome()
      floored = true
    }
    if (!env.PATH) {
      env.PATH = POSIX_FALLBACK_PATH
      floored = true
    }
    return floored ? env : undefined
  }
  const env = stringOnlyProcessEnv(process.env)
  // Why: newly installed CLIs update persisted Windows Path, but the running
  // Electron process keeps its old environment until we merge it explicitly.
  mergePersistedWindowsPath(env)
  return env
}
