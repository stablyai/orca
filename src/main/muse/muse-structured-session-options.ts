import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentModelCatalogLiveListing } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-options-result'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { withLiveCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import {
  MUSE_STRUCTURED_AGENT,
  MUSE_PERMISSION_PROFILE_APPROVAL_MODES
} from './muse-structured-agent-definition'
import type { MspLiveSession } from './muse-structured-live-session'

export function museRejected(reason: string): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('providerExited', {
        neverReachedAgent: true,
        detail: providerDiagnostic(reason, 'person')
      }),
      { surface: 'rejection', agentName: 'Muse' }
    )
  }
}

export function museCurrentOptions(live: MspLiveSession): AgentSessionOptionsResult['current'] {
  return {
    ...(live.options.model ? { model: live.options.model } : {}),
    ...(live.options.effort ? { effort: live.options.effort } : {})
  }
}

export function museFallbackModels(): AgentSessionOptionsResult['models'] {
  return (MUSE_STRUCTURED_AGENT.restingOptions.fallbackModels() ?? []).map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: model.isDefault,
    efforts: model.efforts
  }))
}

export function museOptionsListing(): {
  models: AgentSessionOptionsResult['models']
  catalogListing: AgentModelCatalogLiveListing
} {
  const listing = withLiveCatalogListing({ models: museFallbackModels() }, null)
  return { models: listing.models, catalogListing: listing.catalogListing }
}

export async function applyMuseExecutionOptions(
  live: MspLiveSession,
  choices: { model?: string; effort?: string } | undefined
): Promise<Record<string, string>> {
  const ranOptions: Record<string, string> = {}
  if (choices?.model && choices.model !== live.options.model) {
    await live.msp.setModel(choices.model)
    live.options.model = choices.model
    ranOptions.model = choices.model
  }
  if (choices?.effort && choices.effort !== live.options.effort) {
    await live.msp.setReasoningEffort(choices.effort)
    live.options.effort = choices.effort
    ranOptions.effort = choices.effort
  }
  return ranOptions
}

export async function setMuseSessionOption(
  live: MspLiveSession,
  key: string,
  value: string
): Promise<Readonly<Record<string, string>>> {
  if (key === 'model') {
    await live.msp.setModel(value)
    live.options.model = value
  } else if (key === 'effort') {
    await live.msp.setReasoningEffort(value)
    live.options.effort = value
  } else if (key === 'permissionProfile') {
    const mode = MUSE_PERMISSION_PROFILE_APPROVAL_MODES[value]
    if (!mode) {
      throw new AgentSessionOptionRejectedError(`Muse offers no permission profile named ${value}`)
    }
    await live.msp.setApprovalMode(mode)
    live.options.permissionProfile = value
  } else {
    throw new AgentSessionOptionRejectedError(`Muse offers no session option named ${key}`)
  }
  return { ...live.options }
}
