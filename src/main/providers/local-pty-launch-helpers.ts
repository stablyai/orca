import { basename, delimiter, win32 as pathWin32 } from 'node:path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseWslPath } from '../wsl'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { resolveSafePtyDefaultCwd } from './pty-default-cwd'

const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN'
] as const

export function getDefaultCwd(): string {
  return resolveSafePtyDefaultCwd()
}

export function removeUnspecifiedPaneIdentityEnv(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined
): void {
  for (const key of PANE_IDENTITY_ENV_KEYS) {
    if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
      delete env[key]
    }
  }
}

export function promoteAgentTeamsShimPath(
  env: Record<string, string>,
  requestedPath: string | undefined
): void {
  if (!env.ORCA_AGENT_TEAMS_TEAM_ID || !requestedPath) {
    return
  }
  const normalizedRequestedPath =
    process.platform === 'win32'
      ? expandWindowsEnvironmentVariables(requestedPath, env)
      : requestedPath
  const pathDelimiter = process.platform === 'win32' ? ';' : delimiter
  const shimDir = normalizedRequestedPath.split(pathDelimiter)[0]
  if (!shimDir) {
    return
  }
  const pathKey = resolvePathEnvKey(env, process.platform)
  const currentParts = env[pathKey]?.split(pathDelimiter).filter(Boolean) ?? []
  env[pathKey] = [shimDir, ...currentParts.filter((part) => part !== shimDir)].join(pathDelimiter)
}

export function getWslContextFromWorktreeId(
  worktreeId: string | undefined
): { distro: string; treatPosixCwdAsWsl: true } | undefined {
  // Why: strip any synthetic `::workspace:<uuid>` suffix so WSL detection parses the real path, not a nonexistent identifier.
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  const wslInfo = worktreePath ? parseWslPath(worktreePath) : null
  return wslInfo ? { distro: wslInfo.distro, treatPosixCwdAsWsl: true } : undefined
}

export function getWslContextFromPreferredDistro(
  distro: string | null | undefined
): { distro: string; treatPosixCwdAsWsl: true } | undefined {
  const trimmed = distro?.trim()
  return trimmed ? { distro: trimmed, treatPosixCwdAsWsl: true } : undefined
}

export function normalizeLocalCallerSessionId(
  sessionId: string | undefined,
  allowNumeric = false
): string | null {
  const requested = sessionId?.trim()
  return !requested || (!allowNumeric && /^\d+$/.test(requested)) ? null : requested
}

export function normalizeForegroundProcessName(
  processName: string | null | undefined
): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  return !trimmed || trimmed === 'xterm-256color' ? null : trimmed.split(/[\\/]/).pop() || null
}

export function resolveForegroundFallbackProcess(
  processName: string | null | undefined,
  shellName: string | undefined
): string | null {
  if (process.platform !== 'win32' || normalizeForegroundProcessName(processName)) {
    return processName || null
  }
  return shellName ?? processName ?? null
}

/** Basename of the spawned shell path, parsed for the *target* platform.
 *  Why: POSIX `basename` won't split a Windows `\` path (non-Windows host/CI), so it'd break the foreground comparison. */
export function getSpawnedShellName(shellPath: string): string {
  return process.platform === 'win32' ? pathWin32.basename(shellPath) : basename(shellPath)
}
