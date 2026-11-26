import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import {
  findCommandsOnLocalPath,
  type AgentPathMatch
} from '../ipc/command-path/command-path-batch'
import { isOrcaAgentRuntimePath } from '../managed-agent-cli/managed-agent-cli-path'
import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import { InventoryFsProbes } from '../../shared/shell/command-resolution/inventory-fs-probes'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import { waitForPromiseWithSignal } from '../../shared/concurrency/abort-signal-reason'

type LocalInventoryProgress = { matches: Map<string, AgentPathMatch>; found: Set<string> }

export function partialLocalAgentCommandInventory(progress: LocalInventoryProgress) {
  const found = new Set(progress.found)
  const matches = new Map<string, AgentPathMatch>()
  for (const command of found) {
    const match = progress.matches.get(command)
    if (match) {
      matches.set(command, { ...match })
    }
  }
  return { found, matches, probed: found, incomplete: true }
}

export async function scanLocalAgentCommandInventory(
  probed: ReadonlySet<string>,
  readLoginPath: boolean,
  { matches, found }: LocalInventoryProgress,
  signal: AbortSignal
): Promise<LocalInventoryProgress & { probed: ReadonlySet<string> }> {
  const env =
    buildLocalPreflightEnv() ??
    (readLoginPath
      ? await waitForPromiseWithSignal(resolveLoginShellEnvironment(), signal)
      : process.env)
  const pathEnv = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
  const unverified = new Set<string>()
  const probes = new InventoryFsProbes(signal)
  const direct: string[] = []
  const names: string[] = []
  for (const command of probed) {
    const hasSeparator =
      command.includes('/') || (process.platform === 'win32' && command.includes('\\'))
    const commands = hasSeparator ? direct : names
    commands.push(command)
  }
  const options = {
    env,
    inventory: { isRuntimePath: isOrcaAgentRuntimePath, matches },
    found,
    unverified,
    probes,
    signal
  }
  const scanPathAndInstallers = async (): Promise<void> => {
    await findCommandsOnLocalPath(names, options)
    const installerCommands = names.filter((cmd) => !found.has(cmd) && !hasPathSeparatorToken(cmd))
    let installerUnverified = false
    const installs = await detectCommandsInInstallDirs(installerCommands, pathEnv, {
      skipPathSearch: true,
      fs: {
        probes,
        onUnverified: () => {
          installerUnverified = true
        }
      }
    })
    if (installerUnverified) {
      for (const command of installerCommands) {
        unverified.add(command)
      }
    }
    for (const [command, user] of installs) {
      if (!isOrcaAgentRuntimePath(user)) {
        matches.set(command, { ...matches.get(command), user })
        found.add(command)
      }
    }
  }
  await Promise.all([findCommandsOnLocalPath(direct, options), scanPathAndInstallers()])
  return {
    matches,
    found,
    probed: unverified.size
      ? new Set([...probed].filter((command) => found.has(command) || !unverified.has(command)))
      : probed
  }
}
