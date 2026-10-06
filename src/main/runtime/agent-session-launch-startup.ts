import type { AgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import type { AgentPromptDelivery } from '../../shared/agent-session-host-authority'
import type { WindowsShellSettings } from '../../shared/launch-host'
import type { LaunchFile } from '../../shared/launch-prompt-file'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  agentPromptRidesLaunchCommand,
  type AgentDraftLaunchPlan,
  type AgentStartupPlan
} from '../../shared/tui-agent-startup'
import {
  launchPromptNeedsPasteRefusal,
  windowsDraftRefusal
} from '../../shared/launch-prompt-carry'
import {
  buildExecutionHostDraftLaunchPlan,
  planExecutionHostLaunchPrompt
} from '../opencode/opencode-model-startup-plan'
import { probedThisOrcaLaunchHost } from './this-orca-launch-host'

/** The launch line for an agent session's terminal, and the launch file it names, if any. */
export async function planAgentSessionLaunchStartup(args: {
  agent: TuiAgent
  prompt: string | undefined
  promptDelivery: AgentPromptDelivery | undefined
  startupArgs: AgentStartupPlanInputs
  cwd: string
  hostIdentity: string
  signal: AbortSignal | undefined
  isRemote: boolean
  settings: WindowsShellSettings
  workspacePath: string
}): Promise<{ startup: AgentStartupPlan | AgentDraftLaunchPlan; launchFile?: LaunchFile }> {
  const hostScope = {
    inputs: args.startupArgs,
    cwd: args.cwd,
    hostIdentity: args.hostIdentity,
    signal: args.signal
  }
  if (args.promptDelivery === 'draft') {
    const startup = await buildExecutionHostDraftLaunchPlan({
      ...hostScope,
      draft: args.prompt ?? ''
    })
    if (!startup) {
      const refusal = windowsDraftRefusal(args.agent, args.startupArgs.platform)
      throw new Error(refusal ?? 'agent_session_identity_required')
    }
    return { startup }
  }
  const planned = await planExecutionHostLaunchPrompt({
    ...hostScope,
    prompt: args.prompt ?? '',
    host: await probedThisOrcaLaunchHost({
      launchPlatform: args.startupArgs.platform,
      isRemote: args.isRemote,
      settings: args.settings,
      workspacePath: args.workspacePath,
      prompt: args.prompt
    }),
    // Why: this create returns before the agent is ready, so nothing pastes after it.
    paste: 'never'
  })
  if (!planned) {
    throw new Error('agent_session_identity_required')
  }
  switch (planned.carry) {
    case 'none':
    case 'on-line':
      return { startup: planned.plan }
    case 'launch-file':
      return { startup: planned.plan, launchFile: planned.launchFile }
    case 'paste-after-ready':
      // Why: a stdin agent's prompt is the session's to submit; an argv agent's would be dropped.
      if (agentPromptRidesLaunchCommand(args.agent)) {
        throw new Error(launchPromptNeedsPasteRefusal(args.agent, 'session'))
      }
      return { startup: planned.cleanPlan }
  }
}
