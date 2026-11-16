import type { AgentLaunchPreferences } from '../../../../../../../../shared/agent-session/agent-session-host-authority'
import { checkAgentLaunchModelPreferences } from '../../../../../../../../shared/agent-launch/choices/agent-launch-model-preferences'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { AgentMessageSender } from '../../../../../../../../shared/agent-session/agent-session-message-source'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
}

export type OrchestrationWorkerLaunchReceipt = {
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null
  }
  return { requested: selection, effective: { ...selection } }
}

/** A reuse start launches nothing; the agent already running there is its effective agent, so
 *  mail from a start that never binds still names it. */
export function reusedWorkerLaunchReceipt(
  runtime: Pick<OrcaRuntimeService, 'orchestrationSenderNames'>,
  receipt: OrchestrationWorkerLaunchReceipt,
  party: AgentMessageSender['party']
): OrchestrationWorkerLaunchReceipt {
  if (receipt.effective?.agent) {
    return receipt
  }
  const running = runtime.orchestrationSenderNames.liveAgentOf(party)
  return isTuiAgent(running)
    ? {
        ...receipt,
        effective: { ...(receipt.effective ?? receipt.requested), agent: running }
      }
    : receipt
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
}): OrchestrationWorkerLaunchReceipt {
  return {
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      effort: args.effort ?? null
    },
    effective: null
  }
}

export function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  openCodeModelLaunchSupported?: boolean
  createsWorktree?: boolean
  model?: string
  effort?: string
}): {
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
} {
  const checked = checkAgentLaunchModelPreferences(args)
  if ('refusal' in checked) {
    throw new OrchestrationError(checked.refusal.code, checked.refusal.message)
  }
  const { preferences } = checked
  return {
    preferences,
    receipt: createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
  }
}

export function assertWorkerLaunchPreferencesCreateTerminal(args: {
  terminal?: string
  model?: string
  effort?: string
}): void {
  if (args.terminal && (args.model || args.effort)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--model and --effort cannot be applied when reusing an existing terminal.'
    )
  }
}

export function assertWorkerLaunchPreferencesRuntimeSupported(args: {
  model?: string
  effort?: string
  capabilities?: readonly string[]
  serverName: string
}): void {
  if (
    (args.model || args.effort) &&
    !args.capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support worker model or effort overrides.`
    )
  }
}

export function resolveFederatedWorkerLaunchReceipt(
  remote: OrchestrationWorkerLaunchReceipt | undefined,
  requested: OrchestrationWorkerLaunchReceipt,
  remoteReady: boolean
): OrchestrationWorkerLaunchReceipt {
  if (remote) {
    return remote
  }
  return remoteReady
    ? { requested: requested.requested, effective: { ...requested.requested } }
    : requested
}
