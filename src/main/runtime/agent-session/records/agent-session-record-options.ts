import { agentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionOptionsReplacement } from '../../../../shared/agent-session/options/agent-session-options-replacement'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionModelOption } from '../../../../shared/agent-session/agent-session-wire'
import {
  withLegacyUltracodeEffortLifted,
  withoutChatUltracode
} from '../../../../shared/agent-session/options/claude-ultracode-saved-options'

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
    ? { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
    : { ...record, permissionMode: replacement.permissionMode, updatedAt: replacement.now }
}

/** Closing a chat's tab ends what lasts only while it is open, so its reopen starts Ultracode off. */
export function closedAgentSessionRecord(record: AgentSessionRecord): AgentSessionRecord {
  const options =
    record.provider === 'claude' && record.options
      ? withoutChatUltracode(record.options)
      : record.options
  return options === record.options ? record : { ...record, options }
}

export function restoredAgentSessionRecord(record: AgentSessionRecord): AgentSessionRecord {
  const options =
    record.provider === 'claude' && record.options
      ? withLegacyUltracodeEffortLifted(record.options)
      : record.options
  return options === record.options ? record : { ...record, options }
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
  const saved =
    record.provider === 'claude' &&
    key === 'effort' &&
    (value === 'ultracode' || record.options?.effort === 'ultracode')
      ? withoutChatUltracode(record.options ?? {})
      : record.provider === 'claude' && key === 'ultracode'
        ? withLegacyUltracodeEffortLifted(record.options ?? {})
        : record.options
  return replaceAgentSessionRecordOptions(record, {
    ...at,
    options: { ...saved, [key]: value }
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
