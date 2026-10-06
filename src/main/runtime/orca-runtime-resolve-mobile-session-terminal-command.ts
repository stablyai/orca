// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRunCreateMobileSessionTerminal } from './orca-runtime-run-create-mobile-session-terminal'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { planLaunchPrompt } from '../../shared/tui-agent-startup'
import { probedThisOrcaLaunchHost } from './this-orca-launch-host'
import { launchPromptNeedsPasteRefusal } from '../../shared/launch-prompt-carry'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'

export class OrcaRuntimeWithResolveMobileSessionTerminalCommand extends OrcaRuntimeWithRunCreateMobileSessionTerminal {
  protected async resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: {
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
    }
  ): Promise<{
    command?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
    launchFile?: WorktreeStartupLaunch['launchFile']
  }> {
    if (opts.command || !opts.agent) {
      return {
        command: opts.command,
        env: opts.env,
        envToDelete: opts.envToDelete,
        launchConfig: opts.launchConfig,
        launchAgent: opts.launchAgent,
        startupCommandDelivery: opts.startupCommandDelivery
      }
    }
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const settings = this.store.getSettings()
    if (!isTuiAgentEnabled(opts.agent, settings.disabledTuiAgents)) {
      throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    }
    // Why: mobile may be iOS while the shell host is Windows/macOS/Linux or SSH Linux; quote for the host shell.
    const launchPlatform = this.getAgentLaunchPlatformForWorkspace(workspace)
    const isRemote = Boolean(workspace.connectionId)
    const planned = planLaunchPrompt({
      ...resolveAgentStartupPlanInputs({
        agent: opts.agent,
        settings,
        platform: launchPlatform,
        // Why: SSH runs the CLI through the relay shim (plain `orca`), so the Linux-only `orca-ide` rename must not apply.
        isRemote
      }),
      prompt: opts.agentPrompt ?? '',
      host: await probedThisOrcaLaunchHost({
        launchPlatform,
        isRemote,
        settings,
        workspacePath: workspace.path,
        prompt: opts.agentPrompt
      }),
      // Why: a quick command has no paste after ready.
      paste: 'never'
    })
    if (!planned) {
      throw new Error(`Could not build launch command for ${opts.agent}.`)
    }
    let startupPlan
    let launchFile
    switch (planned.carry) {
      case 'none':
      case 'on-line':
        startupPlan = planned.plan
        break
      case 'launch-file':
        startupPlan = planned.plan
        launchFile = planned.launchFile
        break
      case 'paste-after-ready':
        // Why: a quick command has no paste after ready, so the prompt would be dropped.
        throw new Error(launchPromptNeedsPasteRefusal(opts.agent, 'terminal'))
    }
    return {
      command: startupPlan.launchCommand,
      env: startupPlan.env,
      // Why: a real-home Codex resume strips inherited CODEX_HOME via
      // envToDelete; dropping it here would resume against the wrong home.
      envToDelete: opts.envToDelete,
      launchConfig: startupPlan.launchConfig,
      launchAgent: opts.agent,
      startupCommandDelivery: startupPlan.startupCommandDelivery,
      ...(launchFile ? { launchFile } : {})
    }
  }
}
