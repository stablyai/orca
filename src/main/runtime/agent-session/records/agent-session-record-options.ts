import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionOptionsReplacement } from '../../../../shared/agent-session/options/protocol/agent-session-options-replacement'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionModelOption } from '../../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { agentSessionHoldsProviderConversation } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { modelNamesServingAgent } from '../../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'

export function replaceAgentSessionRecordOptions(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionRecord {
  const { lease } = record
  // At rest the host is the only writer: a pick is intent the next start replays.
  const atRest = lease.claimStatus === 'released' && lease.ownerProcess === null
  if (lease.runtimeFence !== replacement.fence || (lease.claimStatus !== 'live' && !atRest)) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
  }
  // Every reopen serves the saved agent, so a conversation one agent holds can't pass to another.
  const servingAgent = record.options?.model
  if (
    'options' in replacement &&
    modelNamesServingAgent(record.provider) &&
    agentSessionHoldsProviderConversation(record) &&
    servingAgent !== undefined &&
    replacement.options.model !== servingAgent
  ) {
    throw agentSessionRefusalError(
      'agent_session_operation_invalid',
      { reason: 'optionRejected' },
      `this ${record.provider} chat stays with ${servingAgent}; start a new chat for another agent`
    )
  }
  return 'options' in replacement
    ? { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
    : { ...record, permissionMode: replacement.permissionMode, updatedAt: replacement.now }
}

/** Saved catalog only; missing model evidence permits options without starting discovery. */
export type AgentSessionAdmissionModels = readonly AgentSessionModelOption[] | undefined

export type AgentSessionOptionPick = {
  sessionId: string
  fence: number
  key: string
  value: string
  models: AgentSessionAdmissionModels
  now: number
}

export function pickAgentSessionOption(
  record: AgentSessionRecord,
  { key, value, models: _models, ...at }: AgentSessionOptionPick
): AgentSessionRecord {
  return replaceAgentSessionRecordOptions(record, {
    ...at,
    options: { ...record.options, [key]: value }
  })
}

/** Fill only missing options for the still-current model; explicit picks always win. */
export type AgentSessionRanOptions = {
  sessionId: string
  fence: number
  model: string
  options: Readonly<Record<string, string>>
  models: AgentSessionAdmissionModels
  now: number
}

export function recordAgentSessionRanOptions(
  record: AgentSessionRecord,
  { model, options, models: _models, ...at }: AgentSessionRanOptions
): AgentSessionRecord {
  const saved = record.options ?? {}
  // These run options cannot follow a concurrent model change.
  if (saved.model !== undefined && saved.model !== model) {
    return record
  }
  const added = Object.entries({ ...options, model }).filter(
    ([key]) => key !== 'interactionMode' && saved[key] === undefined
  )
  return added.length === 0
    ? record
    : replaceAgentSessionRecordOptions(record, {
        ...at,
        options: { ...Object.fromEntries(added), ...saved }
      })
}
