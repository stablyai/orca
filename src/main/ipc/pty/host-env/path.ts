import { delimiter } from 'node:path'
import { isLegacyTerminalShimPathEntry } from '../../../pty/legacy-terminal-shim-dir'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'
import { getLaunchPath } from '../../../startup/hydrate-shell-path'

export function readInheritedPath(baseEnv: Record<string, string>): string {
  const pathKey = resolvePathEnvKey(baseEnv, process.platform)
  return baseEnv[pathKey] ?? process.env[pathKey] ?? ''
}

/**
 * Replace Orca's own seeded/hydrated PATH with the one Orca was launched with.
 *
 * Why: POSIX panes run a login shell, so the user's profile scripts rebuild
 * PATH from what they inherit. Orca's process PATH carries the startup seed
 * (`patchPackagedProcessPath`) plus the login-shell probe merge, so an rc file
 * that only prepends a directory when it is absent finds its own directories
 * already there and skips them -- leaving them behind /usr/bin once macOS
 * path_helper hoists /etc/paths (stablyai/orca#17446). Seeding exists so the
 * main process can find agent CLIs; a login shell needs none of it.
 *
 * Windows is untouched: its panes get PATH from the registry-backed merge in
 * `windows-environment-path.ts`, and no PowerShell/cmd equivalent of a login
 * profile rebuild is involved.
 *
 * Leaves a PATH the caller composed itself alone, except for the prefix that
 * the agent-teams shim prepends onto Orca's process PATH.
 */
export function restoreLauncherInheritedPath(baseEnv: Record<string, string>): void {
  if (process.platform === 'win32') {
    return
  }
  const launchPath = getLaunchPath()?.value
  if (!launchPath) {
    return
  }
  const seededPath = process.env.PATH ?? ''
  const currentPath = baseEnv.PATH
  if (currentPath === undefined || currentPath === seededPath) {
    baseEnv.PATH = launchPath
    return
  }
  const seededSuffix = `${delimiter}${seededPath}`
  if (seededPath && currentPath.endsWith(seededSuffix)) {
    baseEnv.PATH = `${currentPath.slice(0, -seededPath.length)}${launchPath}`
  }
}

export function firstPathEntry(pathValue: string | undefined): string | null {
  const first = pathValue?.split(delimiter).find((entry) => entry.trim().length > 0)
  return first ?? null
}

export function promoteAgentTeamsShimPath(
  env: Record<string, string> | undefined,
  requestedPath: string | undefined
): void {
  if (!env?.ORCA_AGENT_TEAMS_TEAM_ID) {
    return
  }
  const shimPath = firstPathEntry(requestedPath)
  // Why: requestedPath is captured before buildPtyHostEnv scrubs, so a legacy entry that
  // reached the front would be re-prepended here and outlive the scrub.
  if (!shimPath || isLegacyTerminalShimPathEntry(shimPath)) {
    return
  }
  const currentPathKey = env.PATH !== undefined || env.Path === undefined ? 'PATH' : 'Path'
  const currentPath = env[currentPathKey] ?? ''
  const remaining = currentPath
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== shimPath)
  // Why: host env injection prepends Orca's shims; Claude Agent Teams must still resolve our fake tmux before any real tmux.
  env[currentPathKey] = [shimPath, ...remaining].join(delimiter)
}

export function deleteRequestedEnvKeys(
  env: Record<string, string> | undefined,
  keys: string[] | undefined
): void {
  if (!env || !keys) {
    return
  }
  for (const key of keys) {
    delete env[key]
  }
}
