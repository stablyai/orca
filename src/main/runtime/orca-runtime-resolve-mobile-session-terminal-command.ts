// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRunCreateMobileSessionTerminal } from './orca-runtime-run-create-mobile-session-terminal'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'

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
    const platform = this.getAgentLaunchPlatformForWorkspace(workspace)
    // Why: SSH runs the CLI through the relay shim (plain `orca`), so the Linux-only `orca-ide` rename must not apply.
    const isRemote = Boolean(workspace.connectionId)
    const queuedShell = resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    const startupPlan = buildAgentStartupPlan({
      agent: opts.agent,
      prompt: opts.agentPrompt ?? '',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(opts.agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(opts.agent, settings.agentDefaultEnv),
      platform,
      shell: queuedShell,
      isRemote,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      throw new Error(`Could not build launch command for ${opts.agent}.`)
    }
    if (opts.agentPrompt && startupPlan.followupPrompt) {
      throw new Error(`Agent ${opts.agent} does not support startup prompt quick commands.`)
    }
    await this.markWorkspaceTrustedForAgent(opts.agent, workspace.connectionId, workspace.path)
    return {
      command: startupPlan.launchCommand,
      env: startupPlan.env,
      // Why: a real-home Codex resume strips inherited CODEX_HOME via
      // envToDelete; dropping it here would resume against the wrong home.
      envToDelete: opts.envToDelete,
      launchConfig: startupPlan.launchConfig,
      launchAgent: opts.agent,
      startupCommandDelivery: startupPlan.startupCommandDelivery
    }
  }
}
