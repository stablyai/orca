import path from 'node:path'
import { homedir } from 'node:os'
import { detectInstalledAgentsWithShellPathHydration } from '../../../../preflight/installed-agent-detection'
import { detectWslCommandsOnPath } from '../../../../ipc/preflight-wsl-agent-detection'
import { SshHostNotServedError } from '../../../../providers/ssh-host-not-served-error'
import { detectLocalManagedAgentCliPresence } from '../../../../agent-hooks/installation/local-agent-cli-presence'
import {
  getManagedAgentHookTarget,
  isManagedAgentHookTarget
} from '../../../../../shared/managed-agent-hook-targets'
import { extractExecutableToken } from '../../../../../shared/managed-agent-command-token'
import { isCommandOnLocalPath } from '../../../../ipc/command-path/command-path-resolver'
import { buildLocalPreflightEnv } from '../../../../ipc/preflight-local-env'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchMode } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { hasExplicitTuiLaunchCommand } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { parseWslUncPath } from '../../../../../shared/wsl-paths'
import { resolveStructuredAgentCommand } from '../../../../native-chat/structured-agent-command-resolution'
import { isAgentSessionPreSpawnError } from '../../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { LaunchScopeRuntimeStore } from '../../../../workspaces/execution-host/local-project-runtime-resolution'
import {
  agentLaunchPlatformForScope,
  agentLaunchProjectRuntime,
  newWorktreeLaunchScope
} from '../../../terminal/launch/agent-launch-scope-runtime'
import type { TerminalWorkspaceLaunchScope } from '../../terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'

export type WorkerAgentSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultEnv'>
> &
  Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'>
type WorkerAgentStore = Omit<LaunchScopeRuntimeStore, 'getSettings'> & {
  getSettings: () => WorkerAgentSettings
}

export async function validateWorkerAgentForRepo(
  runtime: Pick<OrcaRuntimeService, 'showRepo' | 'validateOrchestrationAgentLauncher'>,
  store: WorkerAgentStore,
  agent: TuiAgent,
  repoSelector: string,
  mode: AgentLaunchMode = 'terminal'
): Promise<void> {
  runtime.validateOrchestrationAgentLauncher(agent)
  const scope = newWorktreeLaunchScope(await runtime.showRepo(repoSelector), store.getSettings())
  await validateWorkerAgentInScope(store, agent, scope, mode)
}

export async function validateWorkerAgentForWorktree(
  runtime: Pick<
    OrcaRuntimeService,
    'resolveTerminalWorkspaceLaunchScope' | 'validateOrchestrationAgentLauncher'
  >,
  store: WorkerAgentStore,
  agent: TuiAgent,
  worktreeSelector: string,
  mode: AgentLaunchMode = 'terminal'
): Promise<void> {
  runtime.validateOrchestrationAgentLauncher(agent)
  const scope = await runtime.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
  await validateWorkerAgentInScope(store, agent, scope, mode)
}

async function validateWorkerAgentInScope(
  store: WorkerAgentStore,
  agent: TuiAgent,
  scope: TerminalWorkspaceLaunchScope,
  mode: AgentLaunchMode
): Promise<void> {
  if (scope.connectionId) {
    throw new SshHostNotServedError(scope.connectionId)
  }
  const settings = store.getSettings()
  const wsl = parseWslUncPath(scope.path)
  const projectRuntime = wsl ? undefined : agentLaunchProjectRuntime(store, scope, agent)
  const runtimeKind = wsl
    ? 'wsl'
    : projectRuntime?.status === 'resolved'
      ? projectRuntime.runtime.kind
      : undefined
  const platform = agentLaunchPlatformForScope(store, scope)
  const context = { projectRuntime, ...(wsl ? { wslDistro: wsl.distro } : {}) }
  const detected = await detectInstalledAgentsWithShellPathHydration(context, {
    failOnProbeError: true
  })
  if (
    mode === 'structured' &&
    hasExplicitTuiLaunchCommand(settings, agent) &&
    projectRuntime?.status !== 'repair-required' &&
    runtimeKind !== 'wsl'
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
  const override = extractExecutableToken(settings.agentCmdOverrides?.[agent], { platform })
  if (override && runtimeKind === 'wsl') {
    const distro =
      wsl?.distro ??
      (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
        ? projectRuntime.runtime.distro
        : undefined)
    const found = await detectWslCommandsOnPath({ distro }, [override], { failOnProbeError: true })
    if (found.has(override)) {
      return
    }
  } else if (override && projectRuntime?.status !== 'repair-required') {
    const env = {
      ...(buildLocalPreflightEnv() ?? process.env),
      ...settings.agentDefaultEnv?.[agent]
    }
    const pathEnv = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
    const target = isManagedAgentHookTarget(agent) ? getManagedAgentHookTarget(agent) : undefined
    const hasPath = override.includes('/') || (platform === 'win32' && override.includes('\\'))
    if (hasPath) {
      const pathApi = platform === 'win32' ? path.win32 : path.posix
      const program =
        override.startsWith('~/') || (platform === 'win32' && override.startsWith('~\\'))
          ? pathApi.join(homedir(), override.slice(2))
          : pathApi.resolve(scope.path, override)
      if (await isCommandOnLocalPath(program, { env, platform, cwd: scope.path })) {
        return
      }
    } else if (target) {
      const presence = await detectLocalManagedAgentCliPresence(
        [{ ...target, executableCandidates: [override] }],
        settings,
        { pathEnv }
      )
      if (presence[agent]?.state === 'found') {
        return
      }
    } else if (await isCommandOnLocalPath(override, { env, cwd: scope.path })) {
      return
    }
  }
  const teamsFallback =
    agent === 'claude-agent-teams' &&
    detected.includes('claude') &&
    (platform === 'win32' || runtimeKind === 'wsl')
  if (!override && (detected.includes(agent) || teamsFallback)) {
    return
  }
  throw new OrchestrationError(
    'agent_not_available',
    `Agent launcher ${agent} is not installed on the execution host.`
  )
}
