import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import { detectCommandsInInstallDirs } from '../../shared/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { findCommandsOnLocalPath } from '../ipc/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'
import { readGuestWindowsDriveMounts } from '../ipc/wsl-guest-windows-drive-path'

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
    return detectWslCommandsOnPath(wslTarget, commands)
  }
  // Bounded directory scans avoid repeated probes for missing commands (#34636).
  const onPathCommands = await findCommandsOnLocalPath(commands, {
    env: buildLocalPreflightEnv()
  })
  const missedCommands = commands.filter((cmd) => !onPathCommands.has(cmd))
  // Resolve cold-GUI install dirs once; use the same WSL-filtered PATH while retaining process PATH elsewhere.
  const guestMounts = readGuestWindowsDriveMounts()
  // The batch includes the fallback's PATH normalization and Windows executable names.
  const installDirCommands = detectCommandsInInstallDirs(
    missedCommands,
    guestMounts.length > 0 ? buildLocalPreflightEnv(guestMounts)?.PATH : undefined,
    { skipPathSearch: true }
  )
  const foundCommands = new Set(
    commands.filter((cmd) => onPathCommands.has(cmd) || installDirCommands.has(cmd))
  )
  return foundCommands
}
