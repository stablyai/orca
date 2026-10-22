import { independentAgentModelCatalog } from '../../shared/agent-model-catalog-ownership'
import { agentSessionEffortLevels } from '../../shared/agent-session-effort-levels'
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
    ? { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
    : { ...record, permissionMode: replacement.permissionMode, updatedAt: replacement.now }
}

/** Saved catalog rows read before a write without starting discovery; none or an unlisted model
 *  is unknown evidence, which admits everything. */
export type AgentSessionAdmissionModels = readonly AgentSessionModelOption[] | undefined

/** Whether `value` runs under `model`'s listed row: an effort the row lists, Fast the agent replays
 *  there (Claude needs the row's positive support). The saved tier keeps its effective-tier rule. */
export function agentSessionOptionAdmitted(
  provider: string,
  models: AgentSessionAdmissionModels,
  model: string | undefined,
  key: string,
  value: string
): boolean {
  const row = models?.find((entry) => entry.id === model)
  if (!row) {
    return true
  }
  if (key === 'effort') {
    return agentSessionEffortLevels(row)?.has(value) ?? true
  }
  return (
    key !== 'fastMode' ||
    value !== 'true' ||
    (provider === 'claude' ? row.supportsFastMode === true : row.supportsFastMode !== false)
  )
}

/** A new chat's options must run under its model's listed row; refused through the actionable
 *  option refusal otherwise. */
export function assertAgentSessionOptionsAdmitted(
  provider: string,
  models: AgentSessionAdmissionModels,
  options: Readonly<Record<string, string>> | undefined
): void {
  const [key, value] =
    Object.entries(options ?? {}).find(
      ([name, kept]) => !agentSessionOptionAdmitted(provider, models, options?.model, name, kept)
    ) ?? []
  if (key) {
    throw agentSessionRefusalError(
      'agent_session_operation_invalid',
      { reason: 'optionRejected' },
      `${provider} model ${options?.model} does not offer ${key} ${value}`
    )
  }
}

/** A pick, reconciled against the record held at the write: a model pick keeps an inherited
 *  effort or Fast only where the new model runs it. */
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
  { key, value, models, ...at }: AgentSessionOptionPick
): AgentSessionRecord {
  // A live child's own menu may offer more than its saved row (Pi's probe stops at high).
  if (
    key !== 'model' &&
    (independentAgentModelCatalog(record.provider) || record.lease.claimStatus !== 'live')
  ) {
    const { model } = record.options ?? {}
    assertAgentSessionOptionsAdmitted(record.provider, models, {
      ...(model ? { model } : {}),
      [key]: value
    })
  }
  const picked = { ...record.options, [key]: value }
  const options = Object.fromEntries(
    Object.entries(picked).filter(
      ([name, kept]) =>
        key !== 'model' || agentSessionOptionAdmitted(record.provider, models, value, name, kept)
    )
  )
  return replaceAgentSessionRecordOptions(record, { ...at, options })
}

/** What a turn ran on `model`, each value recorded only where the chat has none saved and only
 *  while the chat's model is that one, so a pick, even one made since, always wins. */
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
  { model, options, models, ...at }: AgentSessionRanOptions
): AgentSessionRecord {
  const saved = record.options ?? {}
  // Another model won meanwhile: none of this run's options belong to it.
  if (saved.model !== undefined && saved.model !== model) {
    return record
  }
  const added = Object.entries({ ...options, model }).filter(
    ([key, value]) =>
      saved[key] === undefined &&
      (independentAgentModelCatalog(record.provider) ||
        agentSessionOptionAdmitted(record.provider, models, model, key, value))
  )
  return added.length === 0
    ? record
    : replaceAgentSessionRecordOptions(record, {
        ...at,
        options: { ...Object.fromEntries(added), ...saved }
      })
}
