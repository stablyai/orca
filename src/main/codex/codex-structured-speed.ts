import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../shared/agent-session-wire'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import { readRecord } from './codex-item-field-readers'
import type { CodexOpenedThread } from './codex-structured-thread-open'
import type { CodexSession } from './codex-structured-session-state'

// The session stores a speed, not a Codex tier id: the id a speed routes to is the catalog's
// (`priority` for Fast today) and is resolved again at every send.
export const CODEX_STANDARD_SPEED = 'standard'
const CODEX_FASTER_SPEEDS = ['fast', 'ultrafast'] as const
export type CodexSpeed = typeof CODEX_STANDARD_SPEED | (typeof CODEX_FASTER_SPEEDS)[number]

/** Tier id per faster speed, for one model. */
export type CodexSpeedTiers = Readonly<Record<string, string>>

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function isCodexSpeed(value: unknown): value is CodexSpeed {
  return value === CODEX_STANDARD_SPEED || CODEX_FASTER_SPEEDS.some((speed) => speed === value)
}

function speedOfTier(id: string, name: string): string | undefined {
  return CODEX_FASTER_SPEEDS.find(
    (speed) => name.toLowerCase() === speed || id.toLowerCase() === speed
  )
}

/** The faster speeds one `model/list` row advertises, with the tier each routes to. */
export function readCodexSpeedTiers(row: Record<string, unknown>): {
  speeds: AgentSessionOptionChoice[]
  tiers: CodexSpeedTiers
  supportKnown: boolean
} {
  const modern = Array.isArray(row.serviceTiers) ? row.serviceTiers : null
  const legacy = Array.isArray(row.additionalSpeedTiers) ? row.additionalSpeedTiers : null
  const found = new Map<string, { id: string; choice: AgentSessionOptionChoice }>()
  for (const value of modern ?? []) {
    const tier = readRecord(value)
    const id = text(tier.id)
    const name = text(tier.name)
    const speed = id && name ? speedOfTier(id, name) : undefined
    if (id && name && speed && !found.has(speed)) {
      const description = text(tier.description)
      found.set(speed, {
        id,
        choice: { value: speed, label: name, ...(description ? { description } : {}) }
      })
    }
  }
  const legacyFast = legacy?.map(text).find((tier) => tier?.toLowerCase() === 'fast')
  if (legacyFast && !found.has('fast')) {
    found.set('fast', { id: legacyFast, choice: { value: 'fast', label: 'Fast' } })
  }
  const ordered = CODEX_FASTER_SPEEDS.flatMap((speed) => {
    const entry = found.get(speed)
    return entry ? [[speed, entry] as const] : []
  })
  return {
    speeds: ordered.map(([, entry]) => entry.choice),
    tiers: Object.fromEntries(ordered.map(([speed, entry]) => [speed, entry.id])),
    supportKnown: modern !== null || legacy !== null
  }
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

export function decodeCodexSpeed(options: ReadonlyMap<string, string>): CodexSpeed | undefined {
  const speed = options.get('speed')
  return isCodexSpeed(speed) ? speed : undefined
}

/** A faster speed, or a legacy tier, can only route once the catalog names its tier. */
export function codexSpeedNeedsTier(options: ReadonlyMap<string, string>): boolean {
  const speed = decodeCodexSpeed(options)
  return (speed !== undefined && speed !== CODEX_STANDARD_SPEED) || options.has('serviceTier')
}

/** The speed an older client's Fast toggle means. */
export function codexSpeedOfFastMode(encoded: string): CodexSpeed | undefined {
  const fastMode = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  return typeof fastMode === 'boolean' ? (fastMode ? 'fast' : CODEX_STANDARD_SPEED) : undefined
}

/** What an older client's Fast toggle shows for a speed; Ultrafast is neither on nor off. */
export function codexFastModeOfSpeed(speed: CodexSpeed | undefined): boolean | undefined {
  return speed === 'fast' ? true : speed === CODEX_STANDARD_SPEED ? false : undefined
}

/** The speed a thread's reported tier means for a model, when the catalog can say. */
export function codexSpeedOfTier(
  tier: string | null,
  tiers: CodexSpeedTiers | undefined
): CodexSpeed | undefined {
  if (tier === null || tier === 'default') {
    return CODEX_STANDARD_SPEED
  }
  const speed = Object.entries(tiers ?? {}).find(([, id]) => id === tier)?.[0]
  return isCodexSpeed(speed) ? speed : undefined
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

export function reconcileCodexSpeedOption(
  session: CodexSession,
  input: {
    speedTiersByModel: ReadonlyMap<string, CodexSpeedTiers>
    currentSpeed: string | undefined
    model: string
    /** The model's listed faster speeds; undefined when the catalog does not say. */
    modelSpeeds: readonly AgentSessionOptionChoice[] | undefined
  }
): void {
  if (session.options.has('speed') && decodeCodexSpeed(session.options) === undefined) {
    session.options.delete('speed')
  }
  const legacyTier = session.options.get('serviceTier')
  session.options.delete('serviceTier')
  if (!session.options.has('speed')) {
    const legacySpeed =
      legacyTier === undefined
        ? isCodexSpeed(input.currentSpeed)
          ? input.currentSpeed
          : undefined
        : codexSpeedOfTier(legacyTier, input.speedTiersByModel.get(input.model))
    if (legacySpeed) {
      session.options.set('speed', legacySpeed)
    }
  }
  const speed = decodeCodexSpeed(session.options)
  if (
    speed &&
    speed !== CODEX_STANDARD_SPEED &&
    input.modelSpeeds &&
    !input.modelSpeeds.some((choice) => choice.value === speed)
  ) {
    session.options.set('speed', CODEX_STANDARD_SPEED)
  }
}
