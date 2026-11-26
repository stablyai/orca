import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectWslCommandsOnPath } from '../ipc/preflight/preflight-wsl-agent-detection'
import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import { findCommandsOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import { readGuestWindowsDriveMounts } from '../wsl/filesystem/wsl-guest-windows-drive-path'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import {
  isOrcaAgentRuntimePath,
  withoutOrcaAgentRuntimeDirectories
} from '../managed-agent-cli/managed-agent-cli-path'

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options: {
    connectionId?: string | null
    context?: PreflightRuntimeContext
    /** Filled with the full path of each command found only outside PATH (in an installer's
     *  folder), which a terminal can't run by name. */
    outsidePath?: Map<string, string>
  } = {}
): Promise<Set<string>> {
  if (options.connectionId) {
    throw new SshHostNotServedError(options.connectionId)
  }
  const context = options.context
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return detectWslCommandsOnPath(wslTarget, commands)
  }
  // Bounded directory scans avoid repeated probes for missing commands (#34636).
  const guestMounts = readGuestWindowsDriveMounts()
  const env = buildLocalPreflightEnv(guestMounts) ?? process.env
  const pathKey =
    process.platform === 'win32' && env.PATH === undefined
      ? (Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH')
      : 'PATH'
  const pathEnv = withoutOrcaAgentRuntimeDirectories(env[pathKey] ?? '')
  const userCommands = commands.filter((cmd) => !isOrcaAgentRuntimePath(cmd))
  const onPathCommands = await findCommandsOnLocalPath(userCommands, {
    env: { ...env, [pathKey]: pathEnv }
  })
  // A path was already checked directly; the install-dir fallback would count any absolute path as found.
  const missedCommands = userCommands.filter(
    (cmd) => !onPathCommands.has(cmd) && !hasPathSeparatorToken(cmd)
  )
  // The batch includes the fallback's PATH normalization and Windows executable names.
  const installDirCommands = await detectCommandsInInstallDirs(missedCommands, pathEnv, {
    skipPathSearch: true
  })
  for (const [command, path] of installDirCommands) {
    if (isOrcaAgentRuntimePath(path)) {
      installDirCommands.delete(command)
    }
  }
  const foundCommands = new Set(
    commands.filter((cmd) => onPathCommands.has(cmd) || installDirCommands.has(cmd))
  )
  installDirCommands.forEach((path, command) => options.outsidePath?.set(command, path))
  return foundCommands
}
