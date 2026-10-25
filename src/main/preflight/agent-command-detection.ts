import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import { detectCommandsInInstallDirs } from '../../shared/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { isCommandOnPath } from '../ipc/preflight-command-exec'
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
  const pathChecks = await Promise.all(
    commands.map(async (cmd) => ({
      cmd,
      installedOnPath: await isCommandOnPath(cmd)
    }))
  )
  const missedCommands = pathChecks.filter((check) => !check.installedOnPath).map(({ cmd }) => cmd)
  // Resolve cold-GUI install dirs once; use the same WSL-filtered PATH while retaining process PATH elsewhere.
  const guestMounts = readGuestWindowsDriveMounts()
  const installDirCommands = detectCommandsInInstallDirs(
    missedCommands,
    guestMounts.length > 0 ? buildLocalPreflightEnv(guestMounts)?.PATH : undefined
  )
  const foundCommands = new Set(
    pathChecks
      .filter(({ cmd, installedOnPath }) => installedOnPath || installDirCommands.has(cmd))
      .map(({ cmd }) => cmd)
  )
  return foundCommands
}
