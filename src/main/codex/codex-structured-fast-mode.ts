import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption
} from '../../shared/agent-session-wire'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import type { CodexOpenedThread } from './codex-structured-thread-open'
import type { CodexSession } from './codex-structured-session-state'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function readCodexFastModeTier(row: Record<string, unknown>): {
  id?: string
  supportKnown: boolean
} {
  const modern = Array.isArray(row.serviceTiers) ? row.serviceTiers : null
  const advertised = modern?.flatMap((value) => {
    const tier = record(value)
    const id = text(tier?.id)
    const name = text(tier?.name)
    return id && name ? [{ id, name }] : []
  })
  const exactModern = advertised?.find(
    (tier) => tier.name.toLowerCase() === 'fast' || tier.id.toLowerCase() === 'fast'
  )
  if (exactModern) {
    return { id: exactModern.id, supportKnown: true }
  }
  const legacy = Array.isArray(row.additionalSpeedTiers) ? row.additionalSpeedTiers : null
  const exactLegacy = legacy?.map(text).find((tier) => tier?.toLowerCase() === 'fast')
  return {
    ...(exactLegacy ? { id: exactLegacy } : {}),
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

export function decodeCodexFastMode(options: ReadonlyMap<string, string>): boolean | undefined {
  const encoded = options.get('fastMode')
  if (encoded === undefined) {
    return undefined
  }
  const decoded = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  return typeof decoded === 'boolean' ? decoded : undefined
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

export function reconcileCodexFastModeOption(
  session: CodexSession,
  input: {
    fastModeTierByModel: Map<string, string>
    currentFastMode: boolean | undefined
    model: string
    modelFastModeSupport: boolean | undefined
  }
): void {
  session.fastModeTierByModel = input.fastModeTierByModel
  const encoded = session.options.get('fastMode')
  if (encoded !== undefined && decodeCodexFastMode(session.options) === undefined) {
    session.options.delete('fastMode')
  }
  const legacyTier = session.options.get('serviceTier')
  session.options.delete('serviceTier')
  if (session.options.has('fastMode')) {
    if (session.options.get('fastMode') === 'true' && input.modelFastModeSupport === false) {
      session.options.set('fastMode', 'false')
    }
    return
  }
  if (legacyTier === 'default') {
    session.options.set('fastMode', 'false')
  } else if (
    legacyTier !== undefined &&
    legacyTier === input.fastModeTierByModel.get(input.model)
  ) {
    session.options.set('fastMode', 'true')
  } else if (legacyTier === undefined && input.currentFastMode !== undefined) {
    session.options.set('fastMode', String(input.currentFastMode))
  }
}
