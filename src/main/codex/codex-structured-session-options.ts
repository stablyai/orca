import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import { decodeCodexFastMode, reconcileCodexFastModeOption } from './codex-structured-fast-mode'
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
  const restored = new Map(
    Object.entries(options ?? {}).filter(([key, value]) => {
      return (
        isCodexTurnOptionKey(key) &&
        (key !== 'fastMode' ||
          typeof decodeStructuredAgentSessionOptionValue('fastMode', value) === 'boolean')
      )
    })
  )
  if (!restored.has('fastMode') && restored.get('serviceTier') === 'default') {
    restored.delete('serviceTier')
    restored.set('fastMode', 'false')
  }
  return restored
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
    return {
      models: listing.models,
      fastModeTierByModel: listing.fastModeTierByModel,
      origin: 'live-session'
    }
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
  current: { model?: string; effort?: string; fastMode?: boolean }
  reportedServiceTier?: string | null
  reportedServiceTierKnown?: boolean
  timeoutMs?: number
}): Promise<AgentSessionOptionsResult> {
  return (await readCodexStructuredSessionOptionCatalog(input)).result
}

function composeLiveCodexCatalog(
  session: CodexSession,
  listing: CodexModelCatalogListing
): CodexSessionOptionCatalog {
  const model = session.options.get('model') ?? session.reportedOptions.model
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  return composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(decodeCodexFastMode(session.options) !== undefined
        ? { fastMode: decodeCodexFastMode(session.options) }
        : {})
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
  const catalog = composeLiveCodexCatalog(session, listing)
  reconcileCodexFastModeOption(session, {
    fastModeTierByModel: catalog.fastModeTierByModel,
    currentFastMode: catalog.result.current.fastMode,
    model: catalog.result.current.model,
    modelFastModeSupport: catalog.result.models.find(
      (entry) => entry.id === catalog.result.current.model
    )?.supportsFastMode
  })
  const fastMode = decodeCodexFastMode(session.options)
  return fastMode === undefined
    ? catalog.result
    : { ...catalog.result, current: { ...catalog.result.current, fastMode } }
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
 * bookkeeping must not gate it. Codex judges the model on `turn/start`, and Fast without a
 * known exact tier sends Standard there.
 */
function applyUnlistedCodexSessionOption(
  session: CodexSession,
  key: 'model' | 'effort' | 'fastMode',
  value: string
): Readonly<Record<string, string>> {
  if (key === 'fastMode') {
    session.options.delete('serviceTier')
  } else if (
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
  key: string,
  value: string
): Readonly<Record<string, string>> {
  // `serviceTier` still restores, so a session persisted before Fast existed migrates,
  // but the turn now derives the tier from `fastMode`. Accepting a direct write would
  // report success for a value the next turn discards.
  if (key === 'serviceTier') {
    throw new Error('codex service tier is derived from Fast mode and cannot be set directly')
  }
  if (key !== 'model' && key !== 'effort' && key !== 'fastMode') {
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  const requestedFastMode =
    key === 'fastMode' ? decodeStructuredAgentSessionOptionValue('fastMode', value) : undefined
  if (key === 'fastMode' && typeof requestedFastMode !== 'boolean') {
    throw new Error('codex fast mode must be encoded as true or false')
  }
  if (requestedFastMode === false) {
    session.options.delete('serviceTier')
    session.options.set('fastMode', 'false')
    return Object.fromEntries(session.options)
  }
  const listing = codexAcquireCatalogListing(session.catalogAccess)
  if (!listing) {
    return applyUnlistedCodexSessionOption(session, key, value)
  }
  const priorModel = session.options.get('model') ?? session.reportedOptions.model
  const priorEffort = session.options.get('effort') ?? session.reportedOptions.effort
  const catalog = composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(priorModel ? { model: priorModel } : {}),
      ...(priorEffort ? { effort: priorEffort } : {})
    }
  })
  reconcileCodexFastModeOption(session, {
    fastModeTierByModel: catalog.fastModeTierByModel,
    currentFastMode: catalog.result.current.fastMode,
    model: priorModel ?? catalog.result.current.model,
    modelFastModeSupport: catalog.result.models.find(
      (entry) => entry.id === (priorModel ?? catalog.result.current.model)
    )?.supportsFastMode
  })
  if (key === 'model' && !catalog.result.models.some((entry) => entry.id === value)) {
    throw new Error(`codex app-server does not offer model ${value}`)
  }
  const modelId = key === 'model' ? value : catalog.result.current.model
  const model = catalog.result.models.find((entry) => entry.id === modelId)
  if (key === 'fastMode') {
    if (
      requestedFastMode &&
      (model?.supportsFastMode !== true || !catalog.fastModeTierByModel.has(modelId))
    ) {
      throw new Error(`codex app-server model ${modelId} does not support Fast mode`)
    }
    session.options.set('fastMode', value)
    return Object.fromEntries(session.options)
  }
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
  if (
    key === 'model' &&
    session.options.get('fastMode') === 'true' &&
    model?.supportsFastMode === false
  ) {
    session.options.set('fastMode', 'false')
  }
  return Object.fromEntries(session.options)
}
