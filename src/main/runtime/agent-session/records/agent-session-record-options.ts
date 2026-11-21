import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionOptionsReplacement } from '../../../../shared/agent-session/options/protocol/agent-session-options-replacement'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionModelOption } from '../../../../shared/agent-session/options/model-catalog/agent-session-model-option'

/** What the chat runs on: the agent default it follows, under the chat's own picks. */
export function effectiveAgentSessionOptions(
  record: Pick<AgentSessionRecord, 'options' | 'defaultModelOptions'>
): Record<string, string> | undefined {
  return record.defaultModelOptions === undefined
    ? record.options
    : { ...record.defaultModelOptions, ...record.options }
}

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
  if (!('options' in replacement)) {
    return { ...record, permissionMode: replacement.permissionMode, updatedAt: replacement.now }
  }
  const { defaultModelOptions: saved, ...rest } = record
  const defaults =
    replacement.defaultModelOptions === undefined ? saved : replacement.defaultModelOptions
  return {
    ...rest,
    options: { ...replacement.options },
    ...(defaults ? { defaultModelOptions: { ...defaults } } : {}),
    updatedAt: replacement.now
  }
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

/** A model pick leaves the agent default; what the default resolved to stays the chat's own. */
export function pickAgentSessionOption(
  record: AgentSessionRecord,
  { key, value, models: _models, ...at }: AgentSessionOptionPick
): AgentSessionRecord {
  return replaceAgentSessionRecordOptions(record, {
    ...at,
    options: {
      ...(key === 'model' ? effectiveAgentSessionOptions(record) : record.options),
      [key]: value
    },
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

/** A chat on the agent default learns what it ran into that default, never into its own picks. */
export function recordAgentSessionRanOptions(
  record: AgentSessionRecord,
  { model, options, models: _models, ...at }: AgentSessionRanOptions
): AgentSessionRecord {
  const defaults = record.defaultModelOptions
  if (defaults?.model !== undefined) {
    return record
  }
  const saved = defaults ?? record.options ?? {}
  // These run options cannot follow a concurrent model change.
  if (saved.model !== undefined && saved.model !== model) {
    return record
  }
  const added = Object.entries({ ...options, model }).filter(
    ([key]) => key !== 'interactionMode' && saved[key] === undefined
  )
  if (added.length === 0) {
    return record
  }
  const filled = { ...Object.fromEntries(added), ...saved }
  return replaceAgentSessionRecordOptions(record, {
    ...at,
    ...(defaults
      ? { options: record.options ?? {}, defaultModelOptions: filled }
      : { options: filled })
  })
}
