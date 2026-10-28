import { independentAgentModelCatalog } from '../../shared/agent-model-catalog-ownership'
import { agentSessionEffortLevels } from '../../shared/agent-session-effort-levels'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type {
  AgentSessionOptionsReplacement,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { nearestAgentEffort } from './session-tabs/structured-launch-seed-listing'

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

/** Saved catalog only; missing model evidence permits options without starting discovery. */
export type AgentSessionAdmissionModels = readonly AgentSessionModelOption[] | undefined

/** Check listed effort/Fast support under this model; Claude needs positive Fast support, and saved tiers retain effective-tier rules. */
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

/** Fit a remembered seed to its model's saved row: an effort the row lacks moves to the nearest listed
 *  level, other unlisted values drop; keys the caller named this launch keep strict admission. */
export function seedOptionsAdmittedOnSavedListing(
  provider: string,
  seed: Readonly<Record<string, string>>,
  models: AgentSessionAdmissionModels,
  explicit: ReadonlySet<string>
): Record<string, string> | undefined {
  const admitted: Record<string, string> = {}
  for (const [key, value] of Object.entries(seed)) {
    if (explicit.has(key) || agentSessionOptionAdmitted(provider, models, seed.model, key, value)) {
      admitted[key] = value
      continue
    }
    const row = models?.find((entry) => entry.id === seed.model)
    const nearest =
      key === 'effort' && row
        ? nearestAgentEffort(
            value,
            row.efforts.map((choice) => choice.value)
          )
        : undefined
    if (nearest) {
      admitted[key] = nearest
    }
  }
  return Object.keys(admitted).length > 0 ? admitted : undefined
}

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

/** Reconcile against the record held at write time; retain effort/Fast only if the new model supports it. */
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
  { model, options, models, ...at }: AgentSessionRanOptions
): AgentSessionRecord {
  const saved = record.options ?? {}
  // These run options cannot follow a concurrent model change.
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
