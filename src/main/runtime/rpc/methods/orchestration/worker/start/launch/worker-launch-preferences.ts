import { z } from 'zod'
import type { AgentLaunchPreferences } from '../../../../../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { checkAgentLaunchModelPreferences } from '../../../../../../../../shared/agent-launch/choices/agent-launch-model-preferences'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { lazyZodSchema } from '../../../../../../../../shared/schema/lazy-zod-schema'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { AgentMessageSender } from '../../../../../../../../shared/agent-session/journal/agent-session-message-source'
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

export function formatDroppedRetryLaunchWarning(
  dropped: { model?: string; effort?: string },
  reason: string
): string {
  const parts = [
    dropped.model ? `model ${dropped.model}` : undefined,
    dropped.effort ? `effort ${dropped.effort}` : undefined
  ].filter((part): part is string => Boolean(part))
  const detail = reason.replace(/\s+/g, ' ').trim()
  return `not carrying over ${parts.join(' / ')} from the retried worker: ${detail}`
}

export function joinWorkerStartWarnings(
  ...warnings: readonly (string | undefined)[]
): string | undefined {
  const present = warnings.filter((warning): warning is string => Boolean(warning))
  return present.length ? present.join(' ') : undefined
}

export function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  openCodeModelLaunchSupported?: boolean
  createsWorktree?: boolean
  model?: string
  effort?: string
  inheritedLaunchPreferences?: boolean
}): {
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
  warning?: string
} {
  const checked = checkAgentLaunchModelPreferences(args)
  if ('refusal' in checked) {
    if (args.inheritedLaunchPreferences && (args.model || args.effort)) {
      return {
        preferences: undefined,
        receipt: createWorkerLaunchReceipt({ agent: args.agent }),
        warning: formatDroppedRetryLaunchWarning(args, checked.refusal.message)
      }
    }
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

export function resolveFederatedWorkerLaunchPreferences(args: {
  params: {
    agent?: string
    model?: string
    effort?: string
    inheritedLaunchPreferences?: boolean
  }
  createsWorktree: boolean
  capabilities?: readonly string[]
  serverName: string
}): {
  model: string | undefined
  effort: string | undefined
  requestedLaunch: OrchestrationWorkerLaunchReceipt
  warning?: string
} {
  const { params, createsWorktree, capabilities, serverName } = args
  let { model, effort } = params
  let warning: string | undefined
  const tuiAgent = isTuiAgent(params.agent) ? params.agent : null
  if ((model || effort) && tuiAgent && (tuiAgent !== 'opencode' || createsWorktree)) {
    const checked = checkAgentLaunchModelPreferences({
      agent: tuiAgent,
      createsWorktree,
      model,
      effort
    })
    if ('refusal' in checked) {
      if (!params.inheritedLaunchPreferences) {
        throw new OrchestrationError(checked.refusal.code, checked.refusal.message)
      }
      warning = formatDroppedRetryLaunchWarning({ model, effort }, checked.refusal.message)
      model = undefined
      effort = undefined
    }
  }
  if (
    (model || effort) &&
    !capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    if (!params.inheritedLaunchPreferences) {
      assertWorkerLaunchPreferencesRuntimeSupported({ model, effort, capabilities, serverName })
    }
    warning = formatDroppedRetryLaunchWarning(
      { model, effort },
      `Connected server ${serverName} does not support worker model or effort overrides.`
    )
    model = undefined
    effort = undefined
  }
  return {
    model,
    effort,
    requestedLaunch: createPendingWorkerLaunchReceipt({ agent: tuiAgent, model, effort }),
    ...(warning ? { warning } : {})
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

const RecordedStartOptions = lazyZodSchema(() =>
  z.looseObject({
    agent: z.string().nullish(),
    launch: z
      .looseObject({
        requested: z
          .looseObject({
            agent: z.string().nullish(),
            model: z.string().nullish(),
            effort: z.string().nullish()
          })
          .nullish()
      })
      .nullish()
  })
)

export type RecordedWorkerLaunchOptions = {
  agent?: string
  requestedAgent?: string
  model?: string
  effort?: string
}

function nonEmptyOption(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function parseRecordedWorkerLaunchOptions(raw: string): RecordedWorkerLaunchOptions {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return {}
  }
  const parsed = RecordedStartOptions.safeParse(decoded)
  if (!parsed.success) {
    return {}
  }
  const requested = parsed.data.launch?.requested
  const requestedAgent = nonEmptyOption(requested?.agent)
  return {
    agent: nonEmptyOption(parsed.data.agent) ?? requestedAgent,
    requestedAgent,
    model: nonEmptyOption(requested?.model),
    effort: nonEmptyOption(requested?.effort)
  }
}
