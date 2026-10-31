import { effectiveAgentSessionOptions } from '../../shared/agent-session-default-model'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type {
  AgentSessionOptionsReplacement,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'

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
  return 'options' in replacement
    ? {
        ...record,
        options: { ...replacement.options },
        ...('defaultModelOptions' in replacement
          ? { defaultModelOptions: replacement.defaultModelOptions ?? undefined }
          : {}),
        updatedAt: replacement.now
      }
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
  const options = {
    ...(key === 'model' ? effectiveAgentSessionOptions(record) : record.options),
    [key]: value
  }
  return replaceAgentSessionRecordOptions(record, {
    ...at,
    options,
    ...(key === 'model' ? { defaultModelOptions: null } : {})
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
  const defaultSelected = record.defaultModelOptions !== undefined
  if (record.defaultModelOptions?.model !== undefined) {
    return record
  }
  const saved = (defaultSelected ? record.defaultModelOptions : record.options) ?? {}
  // Another model won meanwhile: none of this run's options belong to it.
  if (saved.model !== undefined && saved.model !== model) {
    return record
  }
  const added = Object.entries({ ...options, model }).filter(([key]) => saved[key] === undefined)
  return added.length === 0
    ? record
    : replaceAgentSessionRecordOptions(record, {
        ...at,
        options: defaultSelected
          ? (record.options ?? {})
          : { ...Object.fromEntries(added), ...saved },
        ...(defaultSelected
          ? { defaultModelOptions: { ...Object.fromEntries(added), ...saved } }
          : {})
      })
}
