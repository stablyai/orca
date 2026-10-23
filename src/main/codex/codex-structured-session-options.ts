import type { StructuredAgentSessionLiveOptions } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import { agentSessionEffortLevels } from '../../shared/agent-session-effort-levels'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import {
  CODEX_DEFAULT_SERVICE_TIER,
  codexFastServiceTier,
  codexOffersServiceTier
} from './codex-structured-service-tier'
import {
  composeCodexSessionOptionCatalog,
  readCodexStructuredSessionOptionCatalog,
  type CodexSessionOptionCatalog
} from './codex-structured-model-catalog'
import {
  codexAcquireCatalogListing,
  codexSessionCapabilities
} from './codex-structured-catalog-entry'
export { codexAcquireCatalogListing } from './codex-structured-catalog-entry'

export function restoredCodexSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  return new Map(Object.entries(options ?? {}).filter(([key]) => isCodexTurnOptionKey(key)))
}

/** Startup reports the thread's defaults together with the saved next-turn intent. */
export function reportedCodexSessionOptions(
  session: CodexSession
): AgentSessionOptionsResult['current'] {
  const model = session.options.get('model') ?? session.reportedOptions.model ?? ''
  const effort =
    session.options.get('effort') ??
    (model === session.reportedOptions.model ? session.reportedOptions.effort : undefined)
  // The saved tier, which the next turn sends as-is.
  const serviceTier = session.options.get('serviceTier')
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {})
  }
}

export type { CodexSessionOptionCatalog } from './codex-structured-model-catalog'

export { readCodexStructuredSessionOptionCatalog } from './codex-structured-model-catalog'

export async function readCodexStructuredSessionOptions(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  current: { model?: string; effort?: string; serviceTier?: string }
  reportedServiceTier?: string | null
  reportedServiceTierKnown?: boolean
  timeoutMs?: number
}): Promise<AgentSessionOptionsResult> {
  return readCodexStructuredSessionOptionCatalog(input)
}

function composeLiveCodexCatalog(
  session: CodexSession,
  listing: ReturnType<typeof codexSessionCapabilities>
): CodexSessionOptionCatalog {
  const model = session.options.get('model') ?? session.reportedOptions.model
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  const serviceTier = session.options.get('serviceTier')
  const catalog = composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(serviceTier ? { serviceTier } : {})
    },
    ...(session.reportedOptions.serviceTierKnown
      ? {
          reportedServiceTier: session.reportedOptions.serviceTier ?? null,
          reportedServiceTierKnown: true
        }
      : {})
  })
  return { ...catalog, fastModeSupport: listing.fastModeSupport }
}

export async function readLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<StructuredAgentSessionLiveOptions> {
  return (await prepareLiveCodexSessionOptions(session, timeoutMs))()
}

/** Demand discovery outside the session lane; compose from its installed snapshot inside it. */
export async function prepareLiveCodexSessionOptions(
  session: CodexSession,
  _timeoutMs: number | undefined
): Promise<() => StructuredAgentSessionLiveOptions> {
  await session.catalogAccess?.demand?.()
  return () => composeLiveCodexCatalog(session, codexSessionCapabilities(session))
}

export async function applyCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string
): Promise<Readonly<Record<string, string>>> {
  try {
    return applyValidatedCodexStructuredSessionOption(session, key, value)
  } catch (error) {
    throw new AgentSessionOptionRejectedError(error)
  }
}

/**
 * With no listing known, a pick is kept as the next turn's intent rather than refused: catalog
 * bookkeeping must not gate it. Codex judges the model and tier on `turn/start`.
 */
function applyUnlistedCodexSessionOption(
  session: CodexSession,
  key: 'model' | 'effort' | 'serviceTier',
  value: string
): Readonly<Record<string, string>> {
  if (
    key === 'model' &&
    value !== (session.options.get('model') ?? session.reportedOptions.model)
  ) {
    // An effort saved under another model is unverified for this one; its default applies.
    session.options.delete('effort')
  }
  session.options.set(key, value)
  return Object.fromEntries(session.options)
}

function applyValidatedCodexStructuredSessionOption(
  session: CodexSession,
  requestedKey: string,
  requestedValue: string
): Readonly<Record<string, string>> {
  const verified = codexAcquireCatalogListing(session.catalogAccess, true)
  const capabilities = codexSessionCapabilities(session)
  const listing =
    requestedKey === 'model' ? verified : capabilities.models.length ? capabilities : null
  const priorModel = session.options.get('model') ?? session.reportedOptions.model
  const catalog = listing
    ? composeCodexSessionOptionCatalog(listing, {
        current: priorModel ? { model: priorModel } : {}
      })
    : null
  // An older client still sends its Fast toggle.
  const key = requestedKey === 'fastMode' ? 'serviceTier' : requestedKey
  const value =
    requestedKey === 'fastMode'
      ? codexServiceTierOfFastMode(
          requestedValue,
          catalog?.models.find((entry) => entry.id === catalog.current.model)
        )
      : requestedValue
  if (key !== 'model' && key !== 'effort' && key !== 'serviceTier') {
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  if (key === 'serviceTier' && value === CODEX_DEFAULT_SERVICE_TIER) {
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  if (!catalog) {
    return applyUnlistedCodexSessionOption(session, key, value)
  }
  if (key === 'model' && !catalog.models.some((entry) => entry.id === value)) {
    throw new Error(`codex app-server does not offer model ${value}`)
  }
  const modelId = key === 'model' ? value : catalog.current.model
  const model = catalog.models.find((entry) => entry.id === modelId)
  if (key === 'serviceTier') {
    if (
      !codexOffersServiceTier(
        session,
        model,
        catalog.models,
        value,
        capabilities.listedServiceTiers
      )
    ) {
      throw new Error(`codex app-server model ${modelId} does not offer the ${value} tier`)
    }
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  const priorEffort = session.options.get('effort') ?? session.reportedOptions.effort
  const requestedEffort = key === 'effort' ? value : priorEffort
  const levels = agentSessionEffortLevels(model)
  if (key === 'effort' && levels && !levels.has(value)) {
    throw new Error(`codex app-server model ${modelId} does not support ${value}`)
  }
  const effort =
    levels === null
      ? requestedEffort
      : levels.size === 0
        ? undefined
        : (model?.efforts.find((entry) => entry.value === requestedEffort)?.value ??
          model?.defaultEffort ??
          model?.efforts[0]?.value)
  session.options.set('model', modelId)
  if (effort) {
    session.options.set('effort', effort)
  } else {
    session.options.delete('effort')
  }
  return Object.fromEntries(session.options)
}

/** The tier an older client's Fast toggle asks for; unknown Fast support is refused. */
function codexServiceTierOfFastMode(
  encoded: string,
  model: Parameters<typeof codexFastServiceTier>[0]
): string {
  const fastMode = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  if (typeof fastMode !== 'boolean') {
    throw new Error('codex fast mode must be encoded as true or false')
  }
  const tier = fastMode ? codexFastServiceTier(model) : CODEX_DEFAULT_SERVICE_TIER
  if (!tier) {
    throw new Error('codex app-server does not support Fast mode for this model')
  }
  return tier
}
