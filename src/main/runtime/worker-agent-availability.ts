import { detectInstalledAgentsWithShellPathHydration } from '../preflight/agent-detection'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectWslCommandsOnPath } from '../ipc/preflight-wsl-agent-detection'
import { detectLocalManagedAgentCliPresence } from '../agent-hooks/local-agent-cli-presence'
import {
  getManagedAgentHookTarget,
  isManagedAgentHookTarget
} from '../../shared/managed-agent-hook-targets'
import { extractExecutableToken } from '../../shared/managed-agent-command-token'
import { isCommandOnLocalPath } from '../ipc/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { OrchestrationError } from './orchestration/orchestration-error'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import type { OrcaRuntimeService } from './orca-runtime'
import { resolveLocalProjectRuntimeForRepo } from '../project-runtime-git-options'
import { agentLaunchPlatformForScope } from './agent-launch-scope-runtime'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import type { AgentLaunchMode } from '../../shared/agent-launch-intent'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { resolveLocalLaunchScopeRuntime } from '../local-project-runtime-resolution'
import { parseWslUncPath } from '../../shared/wsl-paths'

export function validateWorkerAgentEnabled(
  agent: TuiAgent,
  settings: Partial<Pick<GlobalSettings, 'disabledTuiAgents'>> | undefined
): void {
  if (!settings) {
    throw new Error('runtime_unavailable')
  }
  if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Agent launcher ${agent} is disabled or unavailable.`
    )
  }
}

export async function validateWorkerAgentForRepo(
  runtime: Pick<OrcaRuntimeService, 'showRepo' | 'validateOrchestrationAgentLauncher'>,
  store: RuntimeStore,
  agent: TuiAgent,
  repoSelector: string,
  mode: AgentLaunchMode = 'terminal'
): Promise<void> {
  runtime.validateOrchestrationAgentLauncher(agent)
  const repo = await runtime.showRepo(repoSelector)
  const connectionId = getRepoSshConnectionId(repo)
  await validateWorkerAgentAvailability({
    agent,
    mode,
    settings: store.getSettings(),
    repo,
    projectRuntime: connectionId ? undefined : resolveLocalProjectRuntimeForRepo(store, repo),
    platform: agentLaunchPlatformForScope(store, {
      id: '',
      folderWorkspace: null,
      repo,
      path: repo.path,
      connectionId
    })
  })
}

export async function validateWorkerAgentForWorktree(
  runtime: Pick<
    OrcaRuntimeService,
    'resolveTerminalWorkspaceLaunchScope' | 'validateOrchestrationAgentLauncher'
  >,
  store: RuntimeStore,
  agent: TuiAgent,
  selector: string,
  mode: AgentLaunchMode = 'terminal'
): Promise<void> {
  runtime.validateOrchestrationAgentLauncher(agent)
  const scope = await runtime.resolveTerminalWorkspaceLaunchScope(selector)
  const wsl = scope.connectionId ? null : parseWslUncPath(scope.path)
  await validateWorkerAgentAvailability({
    agent,
    mode,
    settings: store.getSettings(),
    repo: scope.repo,
    cwd: scope.path,
    connectionId: scope.connectionId,
    wslDistro: wsl?.distro,
    projectRuntime: wsl ? undefined : resolveLocalLaunchScopeRuntime(store, scope),
    platform: agentLaunchPlatformForScope(store, scope)
  })
}

export async function validateWorkerAgentAvailability(args: {
  agent: TuiAgent
  mode?: AgentLaunchMode
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultEnv'>>
  repo: Repo | null
  cwd?: string
  connectionId?: string | null
  wslDistro?: string
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  platform: NodeJS.Platform
}): Promise<void> {
  const { agent, settings, repo, projectRuntime, platform } = args
  const localRuntimeKind = args.wslDistro
    ? 'wsl'
    : projectRuntime?.status === 'resolved'
      ? projectRuntime.runtime.kind
      : undefined
  let detected: string[]
  const connectionId = args.connectionId ?? (repo ? getRepoSshConnectionId(repo) : null)
  if (connectionId) {
    throw new SshHostNotServedError(connectionId)
  } else {
    detected = await detectInstalledAgentsWithShellPathHydration(
      { projectRuntime, ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}) },
      { failOnProbeError: true }
    )
    if (
      args.mode === 'structured' &&
      hasExplicitTuiLaunchCommand(settings, agent) &&
      projectRuntime?.status !== 'repair-required' &&
      localRuntimeKind !== 'wsl'
    ) {
      try {
        resolveStructuredAgentCommand(agent, settings, { platform })
      } catch (error) {
        if (!isAgentSessionPreSpawnError(error)) {
          throw error
        }
        throw new OrchestrationError(
          'agent_not_available',
          `Agent launcher ${agent} Command setting is not a runnable program on the execution host.`
        )
      }
      return
    }
    const override = extractExecutableToken(settings.agentCmdOverrides?.[agent])
    if (override) {
      detected = []
    }
    if (override && localRuntimeKind === 'wsl') {
      const distro =
        args.wslDistro ??
        (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
          ? projectRuntime.runtime.distro
          : undefined)
      const found = await detectWslCommandsOnPath({ distro }, [override], {
        failOnProbeError: true
      })
      if (found.has(override)) {
        return
      }
    }
    if (override && projectRuntime?.status !== 'repair-required' && localRuntimeKind !== 'wsl') {
      const env = {
        ...(buildLocalPreflightEnv() ?? process.env),
        ...settings.agentDefaultEnv?.[agent]
      }
      const pathEnv = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
      const target = isManagedAgentHookTarget(agent) ? getManagedAgentHookTarget(agent) : undefined
      if (target) {
        const presence = await detectLocalManagedAgentCliPresence(
          [{ ...target, executableCandidates: [override] }],
          settings,
          { pathEnv }
        )
        if (presence[agent]?.state === 'found') {
          return
        }
      } else if (await isCommandOnLocalPath(override, { env, cwd: args.cwd ?? repo?.path })) {
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
