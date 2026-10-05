import { z } from 'zod'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import { resolveCommandsInInstallDirs } from '../ipc/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import { resolveLocalCommandPath } from '../ipc/preflight-command-exec'

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
  return new Set((await resolveAgentCommandPathsOnHost(commands, options.context)).keys())
}

/**
 * Each found command's executable on a local or WSL host. Why paths: an identity probe must
 * run the binary detection matched, not a bare name the child's own PATH re-resolves.
 */
export async function resolveAgentCommandPathsOnHost(
  commands: readonly string[],
  context?: PreflightRuntimeContext
): Promise<Map<string, string>> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return detectWslCommandsOnPath(wslTarget, commands)
  }
  const pathChecks = await Promise.all(
    commands.map(async (cmd) => ({ cmd, resolvedPath: await resolveLocalCommandPath(cmd) }))
  )
  const missedCommands = pathChecks.filter((check) => !check.resolvedPath).map(({ cmd }) => cmd)
  // Why: PATH may still be unhydrated on a cold GUI launch; bulk resolution
  // computes user install dirs once instead of blocking once per missed CLI.
  const installDirPaths = resolveCommandsInInstallDirs(missedCommands)
  const foundPaths = new Map<string, string>()
  for (const { cmd, resolvedPath } of pathChecks) {
    const program = resolvedPath ?? installDirPaths.get(cmd)
    if (program) {
      foundPaths.set(cmd, program)
    }
  }
  return foundPaths
}
