import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionOptionOverridesRefusal } from '../../../../../native-chat/agent-session-wire/structured-agent-session-option-intent'
import {
  codexFastServiceTier,
  CODEX_DEFAULT_SERVICE_TIER
} from '../../../../../codex/codex-structured-service-tier'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export async function preflightStructuredWorkerFast(args: {
  runtime: Pick<
    OrcaRuntimeService,
    'ensureStructuredAgentSessionHost' | 'resolveStructuredAgentSessionLocalWorkspacePath'
  >
  agent: 'claude' | 'codex'
  worktree: string
  model: string | undefined
  fastMode: boolean
}): Promise<string | undefined> {
  const refuse = (reason: string): never => {
    throw new OrchestrationError(
      'capability_unsupported',
      `Cannot apply ${args.agent} Fast: ${reason}. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  if (!args.model) {
    return refuse('--fast requires --model or a model in the role profile')
  }
  await args.runtime.ensureStructuredAgentSessionHost?.()
  const host = getStructuredAgentSessionHost()
  if (!host?.deps.modelCatalog) {
    return refuse('the execution host has no verified model catalog')
  }
  const keyRefusal = structuredAgentSessionOptionOverridesRefusal(
    host.deps.agents,
    args.agent,
    args.agent === 'codex'
      ? { serviceTier: CODEX_DEFAULT_SERVICE_TIER }
      : { fastMode: String(args.fastMode) }
  )
  if (keyRefusal) {
    return refuse(keyRefusal.message ?? 'the provider does not accept Fast')
  }
  const workspacePath = await args.runtime.resolveStructuredAgentSessionLocalWorkspacePath(
    args.worktree
  )
  const listing = await host.deps.modelCatalog.read({
    agent: args.agent,
    workspacePath,
    savedOnly: true,
    verifiedOnly: true
  })
  if (listing.origin === 'unknown' || listing.unavailable) {
    return refuse('refresh this provider’s model catalog in the workspace first')
  }
  const model = listing.models.find((entry) => entry.id === args.model)
  if (!model) {
    return refuse('the selected model is absent from the verified workspace catalog')
  }
  if (
    args.fastMode &&
    (model.supportsFastMode !== true || listing.fastModeSupport?.supported === false)
  ) {
    return refuse('the provider has not advertised Fast for this model and account')
  }
  if (args.agent === 'codex' && args.fastMode && !codexFastServiceTier(model)) {
    return refuse('the provider has not advertised a Fast service tier')
  }
  return args.agent === 'codex'
    ? args.fastMode
      ? codexFastServiceTier(model)
      : CODEX_DEFAULT_SERVICE_TIER
    : undefined
}
