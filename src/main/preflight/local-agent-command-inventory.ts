import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import {
  findCommandsOnLocalPath,
  type AgentPathMatch
} from '../ipc/command-path/command-path-batch'
import { isOrcaAgentRuntimePath } from '../managed-agent-cli/managed-agent-cli-path'
import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'

export async function scanLocalAgentCommandInventory(
  probed: ReadonlySet<string>,
  readLoginPath: boolean,
  localEnv: NodeJS.ProcessEnv | undefined
): Promise<{
  matches: Map<string, AgentPathMatch>
  found: Set<string>
  probed: ReadonlySet<string>
}> {
  const env = localEnv ?? (readLoginPath ? await resolveLoginShellEnvironment() : process.env)
  const pathEnv = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
  const matches = new Map<string, AgentPathMatch>()
  const unverified = new Set<string>()
  const found = await findCommandsOnLocalPath([...probed], {
    env,
    inventory: { isRuntimePath: isOrcaAgentRuntimePath, matches },
    unverified
  })
  const installerCommands = [...probed].filter(
    (cmd) => !found.has(cmd) && !hasPathSeparatorToken(cmd)
  )
  let installerTimedOut = false
  const installs = await detectCommandsInInstallDirs(installerCommands, pathEnv, {
    skipPathSearch: true,
    onProbeTimeout: () => {
      installerTimedOut = true
    }
  })
  for (const [command, user] of installs) {
    if (!isOrcaAgentRuntimePath(user)) {
      matches.set(command, { ...matches.get(command), user })
      found.add(command)
    }
  }
  if (installerTimedOut) {
    for (const command of installerCommands) {
      unverified.add(command)
    }
  }
  return {
    matches,
    found,
    probed: unverified.size
      ? new Set([...probed].filter((command) => found.has(command) || !unverified.has(command)))
      : probed
  }
}
