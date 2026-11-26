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
  const found = await findCommandsOnLocalPath([...probed], {
    env,
    inventory: { isRuntimePath: isOrcaAgentRuntimePath, matches }
  })
  const installs = await detectCommandsInInstallDirs(
    [...probed].filter((cmd) => !found.has(cmd) && !hasPathSeparatorToken(cmd)),
    pathEnv,
    { skipPathSearch: true }
  )
  for (const [command, user] of installs) {
    if (!isOrcaAgentRuntimePath(user)) {
      matches.set(command, { ...matches.get(command), user })
      found.add(command)
    }
  }
  return { matches, found, probed }
}
