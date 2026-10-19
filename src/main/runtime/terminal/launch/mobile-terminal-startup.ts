import { OrcaRuntimeWithRunCreateMobileSessionTerminal } from './mobile-terminal-renderer-create'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/launch-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from '../../../../shared/tui-agent-startup'
import { resolveResumeLaunchRecipe } from '../../../../shared/tui-agent-launch-defaults'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import {
  agentLaunchQuotingShell,
  type AgentLaunchRuntime
} from '../../../../shared/agent-launch-runtime'

export type MobileTerminalCommandOptions = {
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  agent?: TuiAgent
  agentPrompt?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
}

export type MobileTerminalCommand = {
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  /** What the command was quoted for; the create spawns with it. */
  launchRuntime?: AgentLaunchRuntime
}

export type MobileTerminalResumeCommand = MobileTerminalCommand & {
  command: string
  resumeProviderSession: AgentProviderSessionMetadata
}

function normalizeOriginConnectionId(connectionId: string | null | undefined): string | null {
  return connectionId?.trim() || null
}

export abstract class OrcaRuntimeWithResolveMobileSessionTerminalCommand extends OrcaRuntimeWithRunCreateMobileSessionTerminal {
  /** The `--resume` launch for a pane's recorded agent session, as the host window's cold restore builds it. */
  protected resolveMobileSessionResumeCommand(
    workspace: TerminalWorkspaceLaunchScope,
    record: SleepingAgentSessionRecord
  ): MobileTerminalResumeCommand | null {
    const providerSession = normalizeAgentProviderSession(record.providerSession)
    if (!this.store || !providerSession || !isResumableTuiAgent(record.agent)) {
      return null
    }
    // Why: a session id names a transcript on the machine that captured it; elsewhere it cannot resume.
    if (
      record.connectionId !== undefined &&
      normalizeOriginConnectionId(record.connectionId) !==
        normalizeOriginConnectionId(workspace.connectionId)
    ) {
      return null
    }
    const settings = this.store.getSettings()
    if (!isTuiAgentEnabled(record.agent, settings.disabledTuiAgents)) {
      return null
    }
    const launchRuntime = this.resolveAgentLaunchRuntime(workspace, record.agent)
    const { launchConfig } = record
    const startupPlan = buildAgentResumeStartupPlan({
      agent: record.agent,
      providerSession,
      cmdOverrides: settings.agentCmdOverrides ?? {},
      ...resolveResumeLaunchRecipe(launchConfig),
      platform: launchRuntime.platform,
      shell: agentLaunchQuotingShell(launchRuntime),
      isRemote: Boolean(workspace.connectionId)
    })
    if (!startupPlan) {
      return null
    }
    return {
      command: startupPlan.launchCommand,
      env: startupPlan.env,
      launchConfig: startupPlan.launchConfig,
      launchAgent: record.agent,
      startupCommandDelivery: startupPlan.startupCommandDelivery,
      launchRuntime,
      resumeProviderSession: providerSession
    }
  }

  protected async resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: MobileTerminalCommandOptions
  ): Promise<MobileTerminalCommand> {
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
    const launchRuntime = this.resolveAgentLaunchRuntime(workspace, opts.agent)
    const startupPlan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: opts.agent,
        settings,
        // Why: mobile may be iOS while the shell host is Windows/macOS/Linux or SSH Linux; quote for the host shell.
        platform: launchRuntime.platform,
        shell: agentLaunchQuotingShell(launchRuntime),
        // Why: SSH runs the CLI through the relay shim (plain `orca`), so the Linux-only `orca-ide` rename must not apply.
        isRemote: Boolean(workspace.connectionId)
      }),
      prompt: opts.agentPrompt ?? '',
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      throw new Error(`Could not build launch command for ${opts.agent}.`)
    }
    if (opts.agentPrompt && startupPlan.followupPrompt) {
      throw new Error(`Agent ${opts.agent} does not support startup prompt quick commands.`)
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
      launchRuntime
    }
  }
}
