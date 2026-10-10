import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import {
  CODEX_DEFAULT_SERVICE_TIER,
  codexFastServiceTier,
  codexOffersServiceTier,
  dropUnlistedCodexServiceTier
} from './codex-structured-service-tier'
import {
  composeCodexSessionOptionCatalog,
  fetchCodexModelCatalogListing,
  readCodexStructuredSessionOptionCatalog,
  type CodexModelCatalogListing,
  type CodexSessionOptionCatalog
} from './codex-structured-model-catalog'
import { codexAcquireCatalogListing, listingFromEntry } from './codex-structured-catalog-entry'
export { codexAcquireCatalogListing } from './codex-structured-catalog-entry'

export function restoredCodexSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  return new Map(Object.entries(options ?? {}).filter(([key]) => isCodexTurnOptionKey(key)))
}

export type { CodexSessionOptionCatalog } from './codex-structured-model-catalog'

export { readCodexStructuredSessionOptionCatalog } from './codex-structured-model-catalog'

async function fetchCodexListingThroughStore(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<CodexModelCatalogListing> {
  const access = session.catalogAccess
  if (!access) {
    return fetchCodexModelCatalogListing({ connection: session.connection, timeoutMs })
  }
  const entry = await access.store.refresh(access.fingerprint, 'codex', access, async () => {
    const listing = await fetchCodexModelCatalogListing({
      connection: session.connection,
      timeoutMs
    })
    return { models: listing.models, origin: 'live-session' }
  })
  if (!entry) {
    throw new Error(access.store.failureDetail(access.fingerprint) ?? 'codex model listing failed')
  }
  return listingFromEntry(entry)
}

/**
 * The listing a picker read answers with: any stored entry immediately, with a
 * background refresh once it ages out; a provider fetch only when this key has
 * never listed. The refresh rides the session's own connection and its bounded
 * request timeout, off the caller's path.
 */
export async function codexSessionCatalogListingForPicker(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<CodexModelCatalogListing> {
  const access = session.catalogAccess
  const entry = access?.store.get(access.fingerprint)
  if (access && entry) {
    if (access.store.shouldRefresh(access.fingerprint)) {
      void fetchCodexListingThroughStore(session, timeoutMs).catch(() => {})
    }
    return listingFromEntry(entry)
  }
  return fetchCodexListingThroughStore(session, timeoutMs)
}

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
  listing: CodexModelCatalogListing
): CodexSessionOptionCatalog {
  const model = session.options.get('model') ?? session.reportedOptions.model
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  const serviceTier = session.options.get('serviceTier')
  return composeCodexSessionOptionCatalog(listing, {
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
}

function applyLiveCodexCatalog(
  session: CodexSession,
  listing: CodexModelCatalogListing
): AgentSessionOptionsResult {
  dropUnlistedCodexServiceTier(
    session,
    session.options.get('model') ?? session.reportedOptions.model,
    listing.models
  )
  return composeLiveCodexCatalog(session, listing)
}

export async function readLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<AgentSessionOptionsResult> {
  const listing = await codexSessionCatalogListingForPicker(session, timeoutMs)
  return applyLiveCodexCatalog(session, listing)
}

/** Fetch outside the session lane; apply against current options inside it. */
export async function prepareLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<() => AgentSessionOptionsResult> {
  const listing = await codexSessionCatalogListingForPicker(session, timeoutMs)
  return () => applyLiveCodexCatalog(session, listing)
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
  const listing = codexAcquireCatalogListing(session.catalogAccess)
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
    if (!codexOffersServiceTier(session, model, catalog.models, value)) {
      throw new Error(`codex app-server model ${modelId} does not offer the ${value} tier`)
    }
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  const priorEffort = session.options.get('effort') ?? session.reportedOptions.effort
  const requestedEffort = key === 'effort' ? value : priorEffort
  if (
    key === 'effort' &&
    (!model?.efforts.length || !model.efforts.some((effort) => effort.value === requestedEffort))
  ) {
    throw new Error(`codex app-server model ${modelId} does not support ${value}`)
  }
  const effort =
    model?.efforts.length === 0
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
  dropUnlistedCodexServiceTier(session, modelId, catalog.models)
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
