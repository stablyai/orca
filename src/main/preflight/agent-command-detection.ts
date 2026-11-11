import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import {
  detectCommandsInInstallDirs,
  resolveCommandsInInstallDirs
} from '../../shared/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { findCommandsOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { resolveLocalCommandPath } from '../ipc/preflight-command-exec'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'
import { readGuestWindowsDriveMounts } from '../ipc/wsl-guest-windows-drive-path'
import { hasPathSeparatorToken } from '../../shared/managed-agent-command-token'

// Same PATH as the walk: a WSL host's orcad must not re-admit /mnt/<drive> shims; elsewhere keep the process PATH.
function installDirPathEnv(): string | undefined {
  const guestMounts = readGuestWindowsDriveMounts()
  return guestMounts.length > 0 ? buildLocalPreflightEnv(guestMounts)?.PATH : undefined
}

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options: { connectionId?: string | null; context?: PreflightRuntimeContext } = {}
): Promise<Set<string>> {
  if (options.connectionId) {
    throw new SshHostNotServedError(options.connectionId)
  }
  const context = options.context
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return new Set((await detectWslCommandsOnPath(wslTarget, commands)).keys())
  }
  // Bounded directory scans avoid repeated probes for missing commands (#34636).
  const onPathCommands = await findCommandsOnLocalPath(commands, {
    env: buildLocalPreflightEnv()
  })
  // A path was already checked directly; the install-dir fallback would count any absolute path as found.
  const missedCommands = commands.filter(
    (cmd) => !onPathCommands.has(cmd) && !hasPathSeparatorToken(cmd)
  )
  // The batch includes the fallback's PATH normalization and Windows executable names.
  const installDirCommands = detectCommandsInInstallDirs(missedCommands, installDirPathEnv(), {
    skipPathSearch: true
  })
  return new Set(commands.filter((cmd) => onPathCommands.has(cmd) || installDirCommands.has(cmd)))
}

/**
 * The executable a detected command launches, in PATH order. An identity probe must run that
 * binary, not a bare name the child's PATH re-resolves; only identity-gated agents need it.
 */
export async function resolveAgentCommandPathOnHost(
  command: string,
  context?: PreflightRuntimeContext
): Promise<string | null> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return (await detectWslCommandsOnPath(wslTarget, [command])).get(command) ?? null
  }
  return (
    (await resolveLocalCommandPath(command)) ??
    resolveCommandsInInstallDirs([command], installDirPathEnv()).get(command) ??
    null
  )
}
