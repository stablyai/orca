import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents
} from '../preflight/agent-detection'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import { detectLocalManagedAgentCliPresence } from '../agent-hooks/local-agent-cli-presence'
import {
  getManagedAgentHookTarget,
  isManagedAgentHookTarget
} from '../../shared/managed-agent-hook-targets'
import { extractExecutableToken } from '../../shared/managed-agent-command-token'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { KNOWN_TUI_AGENT_DETECTION_COMMANDS } from '../../shared/tui-agent-detection-commands'
import { isCommandOnLocalPath } from '../ipc/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from './orca-runtime'
import type { TuiAgent } from '../../shared/tui-agent'
import { OrchestrationError } from './orchestration/orchestration-error'
import type { resolveLocalProjectRuntimeForRepo } from '../project-runtime-git-options'

export async function validateWorkerAgentAvailability(args: {
  agent: TuiAgent
  settings: ReturnType<Store['getSettings']>
  repo: Awaited<ReturnType<OrcaRuntimeService['showRepo']>>
  projectRuntime: ReturnType<typeof resolveLocalProjectRuntimeForRepo> | undefined
  platform: NodeJS.Platform
}): Promise<void> {
  const { agent, settings, repo, projectRuntime, platform } = args
  const localRuntimeKind =
    projectRuntime?.status === 'resolved' ? projectRuntime.runtime.kind : undefined
  let detected: string[]
  if (repo.connectionId) {
    const override = extractExecutableToken(settings.agentCmdOverrides?.[agent])
    const config = TUI_AGENT_CONFIG[agent]
    const commands = override
      ? [
          ...KNOWN_TUI_AGENT_DETECTION_COMMANDS,
          {
            id: agent,
            cmd: override,
            ...(config.detectRequiredCommands
              ? { requiredCommands: config.detectRequiredCommands }
              : {}),
            ...(config.detectUnsupportedRuntimes
              ? { unsupportedRuntimes: config.detectUnsupportedRuntimes }
              : {})
          }
        ]
      : undefined
    detected = await detectRemoteAgents({
      connectionId: repo.connectionId,
      commands,
      requireAvailable: true
    })
  } else {
    detected = await detectInstalledAgentsWithShellPathHydration(
      { projectRuntime },
      { failOnProbeError: true }
    )
    const override = extractExecutableToken(settings.agentCmdOverrides?.[agent])
    if (
      !detected.includes(agent) &&
      override &&
      projectRuntime?.status === 'resolved' &&
      projectRuntime.runtime.kind === 'wsl'
    ) {
      const found = await detectWslCommandsOnPath(
        { distro: projectRuntime.runtime.distro },
        [override],
        { failOnProbeError: true }
      )
      if (found.has(override)) {
        return
      }
    }
    if (
      !detected.includes(agent) &&
      override &&
      projectRuntime?.status !== 'repair-required' &&
      localRuntimeKind !== 'wsl'
    ) {
      const env = {
        ...(buildLocalPreflightEnv() ?? process.env),
        ...settings.agentDefaultEnv?.[agent]
      }
      const pathEnv = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
      const target = isManagedAgentHookTarget(agent) ? getManagedAgentHookTarget(agent) : undefined
      if (target) {
        const presence = await detectLocalManagedAgentCliPresence([target], settings, { pathEnv })
        if (presence[agent]?.state === 'found') {
          return
        }
      } else if (await isCommandOnLocalPath(override, { env, cwd: repo.path })) {
        return
      }
    }
  }
  const usesClaudeTeamsFallback =
    agent === 'claude-agent-teams' &&
    detected.includes('claude') &&
    (platform === 'win32' ||
      (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'))
  if (!detected.includes(agent) && !usesClaudeTeamsFallback) {
    throw new OrchestrationError(
      'agent_not_available',
      `Agent launcher ${agent} is not installed on the execution host.`
    )
  }
}
