import type { AgentLaunchPreferences } from '../../../../../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { checkAgentLaunchModelPreferences } from '../../../../../../../../shared/agent-launch/choices/agent-launch-model-preferences'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { AgentMessageSender } from '../../../../../../../../shared/agent-session/journal/agent-session-message-source'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import { readLaunchPermissionChoice } from '../../../../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode-option-id'
import {
  narrowStructuredLaunchSeedOptions,
  parseStructuredLaunchSeedOptions
} from '../../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-defaults'

export function structuredWorkerLaunchOptions(
  preferences: AgentLaunchPreferences | undefined
): Record<string, string> | undefined {
  return parseStructuredLaunchSeedOptions({
    ...narrowStructuredLaunchSeedOptions(preferences),
    [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: readLaunchPermissionChoice(preferences)
  })
}

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

/** A chat worker launches with the model and effort its session was seeded with, not only those the caller asked for. */
export function structuredWorkerLaunchReceipt(
  receipt: OrchestrationWorkerLaunchReceipt,
  options: Readonly<Record<string, string>> | undefined
): OrchestrationWorkerLaunchReceipt {
  return {
    ...receipt,
    effective: {
      ...(receipt.effective ?? receipt.requested),
      model: options?.model ?? null,
      effort: options?.effort ?? null
    }
  }
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
