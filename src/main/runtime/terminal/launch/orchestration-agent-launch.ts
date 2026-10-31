import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import type { AgentLaunchScope } from '../../session-tabs/structured-session-tab-restoration'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import { resolveAgentLaunchCommand } from '../../../../shared/tui-agent-launch-command'
import { agentLaunchQuotingShell } from '../../../../shared/agent-launch-runtime'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../../shared/tui-agent-startup-shell'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { resolveConfiguredWorkerAgent } from '../../orchestration/configured-worker-agent-selector'
import { newWorktreeLaunchScope, resolveAgentLaunchRuntime } from '../../agent-launch-scope-runtime'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { resolveOpenCodeModelLaunchRoute } from '../../../opencode/opencode-model-startup-plan'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } from '../adoption/adopt-terminal-orphans-from-inventory'

export abstract class OrcaRuntimeWithOrchestrationAgentLaunch extends OrcaRuntimeWithAdoptTerminalOrphansFromInventory {
  protected abstract getAgentLaunchPlatformForWorkspace(scope: AgentLaunchScope): NodeJS.Platform

  resolveOrchestrationAgentLauncher(
    selector: string,
    platform: NodeJS.Platform = process.platform,
    shell?: AgentStartupShell
  ): TuiAgent | undefined {
    return resolveConfiguredWorkerAgent(
      selector,
      this.store?.getSettings().agentCmdOverrides ?? {},
      platform,
      shell
    )
  }

  async resolveOrchestrationAgentLauncherForTarget(
    selector: string,
    target: { repo?: string; worktree?: string }
  ): Promise<TuiAgent | undefined> {
    if (isTuiAgent(selector)) {
      return selector
    }
    const repo = target.repo ? await this.resolveRepoSelector(target.repo) : null
    // SAFETY: Forward an absent target unchanged; the existing resolver owns validation.
    const workspace = repo
      ? { repo, path: repo.path, connectionId: getRepoRoutingConnectionId(repo) }
      : await this.resolveTerminalWorkspaceLaunchScope(target.worktree!)
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const shell = resolveStartupShell(
      platform,
      resolveLocalWindowsAgentStartupShell({
        platform,
        isRemote: Boolean(workspace.connectionId),
        terminalWindowsShell: this.store?.getSettings().terminalWindowsShell
      })
    )
    return this.resolveOrchestrationAgentLauncher(selector, platform, shell)
  }

  async probeOrchestrationOpenCodeModelLaunchSupport(target: {
    worktree?: string
    model?: string
  }): Promise<boolean> {
    if (!target.model || !target.worktree) {
      return false
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(target.worktree)
    const executionRepo = workspace?.repo
    if (
      workspace?.connectionId ||
      (executionRepo?.executionHostId && executionRepo.executionHostId !== 'local')
    ) {
      return false
    }
    const store = this.requireStore()
    const path = workspace?.path
    if (!path) {
      return false
    }
    // The launch's own platform, and `isWsl` from the path alone, as main read it.
    let launchRuntime
    try {
      launchRuntime = resolveAgentLaunchRuntime(store, workspace, undefined, 'opencode')
    } catch {
      return false
    }
    if (
      !target.model.trim() ||
      launchRuntime.platform !== process.platform ||
      parseWslUncPath(path)
    ) {
      return false
    }
    await resolveOpenCodeModelLaunchRoute({
      inputs: resolveAgentStartupPlanInputs({
        agent: 'opencode',
        settings: store.getSettings(),
        platform: launchRuntime.platform,
        isRemote: false,
        shell: undefined,
        sessionOptions: { model: target.model }
      }),
      cwd: path,
      hostIdentity: this.getRuntimeId()
    })
    return true
  }

  async preflightOrchestrationWorkerLaunch(
    agent: TuiAgent,
    preferences: AgentLaunchPreferences | undefined,
    target: { repo?: string; worktree?: string }
  ): Promise<void> {
    const store = this.requireStore()
    const settings = store.getSettings()
    const workspace = target.repo
      ? newWorktreeLaunchScope(await this.resolveRepoSelector(target.repo), settings)
      : await this.resolveTerminalWorkspaceLaunchScope(target.worktree!)
    const launchRuntime = resolveAgentLaunchRuntime(store, workspace, undefined, agent)
    const inputs = resolveAgentStartupPlanInputs({
      agent,
      settings,
      platform: launchRuntime.platform,
      isRemote: Boolean(workspace.connectionId),
      shell: agentLaunchQuotingShell(launchRuntime),
      ...(preferences ? { sessionOptions: { ...preferences } } : {})
    })
    const command = resolveAgentLaunchCommand({
      ...inputs,
      shell: resolveStartupShell(inputs.platform, inputs.shell)
    })
    if (!command.ok) {
      throw new OrchestrationError('invalid_argument', command.error, { effectsApplied: false })
    }
    for (const [option, value] of Object.entries(preferences ?? {})) {
      if (command.appliedSessionOptions[option] !== value) {
        throw new OrchestrationError(
          'capability_unsupported',
          `Agent ${agent} cannot apply launch option ${option}. No effects were applied.`,
          { effectsApplied: false }
        )
      }
    }
  }

  validateOrchestrationAgentLauncher(agent: TuiAgent): void {
    const settings = this.store?.getSettings()
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
}
