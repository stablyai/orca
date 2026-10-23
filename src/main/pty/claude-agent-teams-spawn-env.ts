import { basename, delimiter } from 'node:path'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { resolvePathEnvKey } from './windows-environment-path'

const TEAM_ID_ENV = 'ORCA_AGENT_TEAMS_TEAM_ID'
const TMUX_SHIM_DIR_ENV = 'ORCA_AGENT_TEAMS_SHIM_DIR'
const IT2_SHIM_DIR_ENV = 'ORCA_AGENT_TEAMS_IT2_SHIM_DIR'
const IT2_PROBE_SHELL_ENV = 'ORCA_AGENT_TEAMS_IT2_PROBE_SHELL'
const REAL_SHELL_ENV = 'ORCA_AGENT_TEAMS_REAL_SHELL'
const CLAUDE_CODE_SHELL_ENV = 'CLAUDE_CODE_SHELL'

function selectPromotedPathEntries(
  env: Record<string, string>,
  requestedEntries: string[]
): string[] {
  const firstEntry = requestedEntries[0]
  const fallback = firstEntry ? [firstEntry] : []
  const it2ShimDir = env[IT2_SHIM_DIR_ENV]
  if (!it2ShimDir) {
    return fallback
  }
  // Why by name, not by position: host env injection can slide Orca dirs between the two shim dirs.
  const promoted: string[] = []
  for (const dir of [it2ShimDir, env[TMUX_SHIM_DIR_ENV]]) {
    if (dir && requestedEntries.includes(dir)) {
      promoted.push(dir)
    }
  }
  return promoted.length > 0 ? promoted : fallback
}

/** Promotes the agent-teams shim dirs (it2 first, then tmux) ahead of inherited PATH entries. */
export function promoteAgentTeamsShimPath(
  env: Record<string, string>,
  requestedPath: string | undefined
): void {
  if (!env[TEAM_ID_ENV] || !requestedPath) {
    return
  }
  const normalizedRequestedPath =
    process.platform === 'win32'
      ? expandWindowsEnvironmentVariables(requestedPath, env)
      : requestedPath
  const pathDelimiter = process.platform === 'win32' ? ';' : delimiter
  const promoted = selectPromotedPathEntries(env, normalizedRequestedPath.split(pathDelimiter))
  if (promoted.length === 0) {
    return
  }
  const pathKey = resolvePathEnvKey(env, process.platform)
  const currentParts = env[pathKey]?.split(pathDelimiter).filter(Boolean) ?? []
  env[pathKey] = [...promoted, ...currentParts.filter((part) => !promoted.includes(part))].join(
    pathDelimiter
  )
}

/**
 * Makes the spawned shell see the it2 probe shell as SHELL once the PTY's real shell is chosen.
 *
 * Why here and not earlier: Orca derives the PTY's shell from env.SHELL, so the probe must only
 * replace it after that choice. Keyed on the requested env so a stale value inherited from a
 * parent Orca pane is dropped instead of rewriting an unrelated pane's SHELL.
 */
export function applyAgentTeamsProbeShellEnv(args: {
  env: Record<string, string>
  requestedEnv: Record<string, string> | undefined
  realShellPath: string
  platform?: NodeJS.Platform
}): void {
  const { env, requestedEnv, realShellPath, platform = process.platform } = args
  if (platform === 'win32') {
    return
  }
  if (!requestedEnv?.[IT2_PROBE_SHELL_ENV]) {
    // Why: the shell-ready restore re-points SHELL at any probe it sees, so a stale inherited one must go.
    delete env[IT2_PROBE_SHELL_ENV]
    delete env[IT2_SHIM_DIR_ENV]
    return
  }
  const probeShell = env[IT2_PROBE_SHELL_ENV]
  if (!probeShell) {
    return
  }
  const previousRealShell = env[REAL_SHELL_ENV]
  env[REAL_SHELL_ENV] = realShellPath
  env.SHELL = probeShell
  // Why: Claude's Bash tool also reads SHELL, and the probe shell must not become its interpreter.
  // A value matching the previous real shell is ours from a failed primary spawn, so a fallback replaces it.
  const claudeShell = env[CLAUDE_CODE_SHELL_ENV]
  if (!claudeShell || claudeShell === previousRealShell) {
    if (/bash|zsh/.test(basename(realShellPath))) {
      env[CLAUDE_CODE_SHELL_ENV] = realShellPath
    } else {
      delete env[CLAUDE_CODE_SHELL_ENV]
    }
  }
}
