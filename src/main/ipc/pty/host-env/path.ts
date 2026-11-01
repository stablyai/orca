import { delimiter } from 'node:path'
import { isLegacyTerminalShimPathEntry } from '../../../pty/legacy-terminal-shim-dir'
import { resolvePathEnvKey } from '../../../pty/windows-environment-path'

export function readInheritedPath(
  baseEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): string {
  const pathKey = resolvePathEnvKey(baseEnv, platform)
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
  // requestedPath predates cleanup; re-prepending a legacy entry would undo the scrub.
  if (!shimPath || isLegacyTerminalShimPathEntry(shimPath)) {
    return
  }
  const currentPathKey = env.PATH !== undefined || env.Path === undefined ? 'PATH' : 'Path'
  const currentPath = env[currentPathKey] ?? ''
  const remaining = currentPath
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== shimPath)
  // Agent Teams must resolve Orca's tmux shim before any real tmux, including after host prepends.
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
