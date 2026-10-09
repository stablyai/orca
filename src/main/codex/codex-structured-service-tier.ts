import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../shared/agent-session-wire'
import { readRecord } from './codex-item-field-readers'
import type { CodexOpenedThread } from './codex-structured-thread-open'
import type { CodexSession } from './codex-structured-session-state'

/** Codex's request value for a model's standard tier. */
export const CODEX_DEFAULT_SERVICE_TIER = 'default'

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** The tiers one `model/list` row advertises, valued by the id Codex takes back on `turn/start`. */
export function readCodexServiceTiers(
  row: Record<string, unknown>
): AgentSessionOptionChoice[] | undefined {
  const modern = Array.isArray(row.serviceTiers) ? row.serviceTiers : []
  if (modern.length > 0) {
    return modern.flatMap((value) => {
      const tier = readRecord(value)
      const id = text(tier.id)
      const name = text(tier.name)
      const description = text(tier.description)
      return id && name ? [{ value: id, label: name, ...(description ? { description } : {}) }] : []
    })
  }
  // Older catalogs list bare ids instead, sometimes beside an empty `serviceTiers`.
  if (Array.isArray(row.additionalSpeedTiers) && row.additionalSpeedTiers.length > 0) {
    return row.additionalSpeedTiers.flatMap((value) => {
      const id = text(value)
      return id ? [{ value: id, label: id.toLowerCase() === 'fast' ? 'Fast' : id }] : []
    })
  }
  return Array.isArray(row.serviceTiers) || Array.isArray(row.additionalSpeedTiers) ? [] : undefined
}

/** The tier an older client's Fast toggle stands for. */
export function codexFastServiceTier(
  model: Pick<AgentSessionModelOption, 'serviceTiers'> | undefined
): string | undefined {
  return model?.serviceTiers?.find(
    (tier) => tier.label.toLowerCase() === 'fast' || tier.value.toLowerCase() === 'fast'
  )?.value
}

/** What an older client's Fast toggle shows for a tier; any other tier is neither on nor off. */
export function codexFastModeOfServiceTier(
  tier: string | undefined,
  model: Pick<AgentSessionModelOption, 'serviceTiers'> | undefined
): boolean | undefined {
  if (tier === undefined) {
    return undefined
  }
  if (tier === CODEX_DEFAULT_SERVICE_TIER) {
    return false
  }
  return tier === codexFastServiceTier(model) ? true : undefined
}

export function codexFastModeSupport(
  models: readonly AgentSessionModelOption[]
): AgentSessionFastModeSupport | undefined {
  if (models.some((model) => model.supportsFastMode === true)) {
    return { supported: true }
  }
  return models.length > 0 && models.every((model) => model.supportsFastMode === false)
    ? { supported: false, reason: 'model-not-supported' }
    : undefined
}

export function reportedCodexThreadOptions(
  opened: CodexOpenedThread
): CodexSession['reportedOptions'] {
  return {
    ...(opened.model ? { model: opened.model } : {}),
    ...(opened.effort ? { effort: opened.effort } : {}),
    ...('serviceTier' in opened
      ? { serviceTier: opened.serviceTier ?? null, serviceTierKnown: true as const }
      : {})
  }
}

/** A picked tier the model does not list falls back to standard. A tier Codex reports for the
 *  thread is Codex's to judge (it accepts unlisted ones such as `flex`), so it is never rewritten. */
export function dropUnlistedCodexServiceTier(
  session: CodexSession,
  model: Pick<AgentSessionModelOption, 'serviceTiers'> | undefined
): void {
  const tier = session.options.get('serviceTier')
  if (
    tier !== undefined &&
    tier !== CODEX_DEFAULT_SERVICE_TIER &&
    model?.serviceTiers &&
    !model.serviceTiers.some((choice) => choice.value === tier)
  ) {
    session.options.set('serviceTier', CODEX_DEFAULT_SERVICE_TIER)
  }
}
