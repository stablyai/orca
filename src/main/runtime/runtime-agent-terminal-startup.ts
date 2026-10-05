import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveBareAgentLaunchCommand } from './runtime-agent-launch-resolution'
import { planExecutionHostLaunchPrompt } from '../opencode/opencode-model-startup-plan'
import { launchPromptNeedsPasteRefusal } from '../../shared/launch-prompt-carry'
import { probedThisOrcaLaunchHost } from './this-orca-launch-host'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'

export async function buildRuntimeAgentTerminalStartupOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  settings: ReturnType<RuntimeStore['getSettings']>,
  platform: NodeJS.Platform,
  sessionOptions: Record<string, SessionOptionValue> | undefined,
  hostIdentity: string
): Promise<TerminalCreateOptions> {
  // Why: `workspace.repo` is display metadata and may be a row from another host; the launch
  // shape must match the PTY route this scope already resolved.
  const isRemote = Boolean(workspace.connectionId)
  if (opts.startupAgent && !isTuiAgentEnabled(opts.startupAgent, settings.disabledTuiAgents)) {
    throw new Error(`Agent ${opts.startupAgent} is disabled. Choose an enabled agent.`)
  }
  const agent =
    opts.startupAgent ??
    resolveBareAgentLaunchCommand({
      command: opts.command,
      settings,
      platform,
      isRemote
    })
  if (!agent) {
    return opts
  }

  const startupCwd = resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path
  // A caller that wrote its own launch file already passes the pointer to it as the prompt.
  const planned = await planExecutionHostLaunchPrompt({
    inputs: resolveAgentStartupPlanInputs({
      agent,
      settings,
      platform,
      isRemote,
      ...(opts.agentArgs !== undefined ? { agentArgs: opts.agentArgs } : {}),
      // A requested shell is the one this PTY will actually be, so it owns the quoting family.
      windowsShellOverride: opts.shellOverride,
      sessionOptions: sessionOptions
    }),
    cwd: startupCwd,
    hostIdentity,
    prompt: opts.startupPrompt ?? '',
    ...(opts.launchFile ? { launchFile: opts.launchFile } : {}),
    host: await probedThisOrcaLaunchHost({
      launchPlatform: platform,
      isRemote,
      settings,
      windowsShellOverride: opts.shellOverride,
      workspacePath: workspace.path,
      // A caller's own launch file already carries the prompt, so no line needs staging.
      ...(opts.launchFile ? {} : { prompt: opts.startupPrompt })
    }),
    paste:
      opts.startupPromptPaste ?? (opts.onStartupPromptCarry ? 'when-host-proves-agent' : 'never')
  })
  if (!planned) {
    // Why: an explicit agent that yields no plan would otherwise spawn a bare
    // shell that never reaches agent readiness.
    if (opts.startupAgent) {
      throw new Error(`Could not build launch command for ${opts.startupAgent}.`)
    }
    return opts
  }
  let startupPlan
  let launchFile
  switch (planned.carry) {
    case 'none':
      startupPlan = planned.plan
      break
    case 'on-line':
      startupPlan = planned.plan
      opts.onStartupPromptCarry?.(true)
      break
    case 'launch-file':
      startupPlan = planned.plan
      launchFile = planned.launchFile
      opts.onStartupPromptCarry?.(true)
      break
    case 'paste-after-ready':
      if (!opts.onStartupPromptCarry) {
        // Why: this create returns options, not a live PTY, so the prompt would be dropped.
        throw new Error(launchPromptNeedsPasteRefusal(agent, 'terminal'))
      }
      startupPlan = planned.cleanPlan
      opts.onStartupPromptCarry(false)
      break
  }

  return {
    ...opts,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    startupCommandDelivery: startupPlan.startupCommandDelivery,
    ...(launchFile ? { launchFile } : {}),
    // A bare command the user typed stays out of launch accounting, as before.
    ...(opts.startupAgent ? { telemetry: agentStartedTelemetry(agent, opts.launchSource) } : {})
  }
}
