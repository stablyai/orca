import { z } from 'zod'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import { detectCommandsInInstallDirs } from '../ipc/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { isCommandOnPath } from '../ipc/preflight-command-exec'

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options: { connectionId?: string | null; context?: PreflightRuntimeContext } = {}
): Promise<Set<string>> {
  if (options.connectionId) {
    const mux = getActiveMultiplexer(options.connectionId)
    if (!mux || mux.isDisposed()) {
      throw new Error('Agent command resolution requires the execution host connection.')
    }
    const result = z.object({ agents: z.array(z.string()) }).parse(
      await mux.request('preflight.detectAgents', {
        commands: commands.map((cmd) => ({ id: cmd, cmd }))
      })
    )
    return new Set(result.agents.filter((cmd) => commands.includes(cmd)))
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
  // Why: PATH may still be unhydrated on a cold GUI launch; bulk resolution
  // computes user install dirs once instead of blocking once per missed CLI.
  const installDirCommands = detectCommandsInInstallDirs(missedCommands)
  const foundCommands = new Set(
    pathChecks
      .filter(({ cmd, installedOnPath }) => installedOnPath || installDirCommands.has(cmd))
      .map(({ cmd }) => cmd)
  )
  return foundCommands
}
