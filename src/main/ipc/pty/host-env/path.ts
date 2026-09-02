import { delimiter } from 'node:path'
import { isLegacyTerminalShimPathEntry } from '../../../pty/legacy-terminal-shim-dir'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'

export function readInheritedPath(baseEnv: Record<string, string>): string {
  const pathKey = resolvePathEnvKey(baseEnv, process.platform)
  return baseEnv[pathKey] ?? process.env[pathKey] ?? ''
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
