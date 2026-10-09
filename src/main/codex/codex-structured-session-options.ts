import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  CODEX_STANDARD_SPEED,
  codexFastModeOfSpeed,
  codexSpeedOfFastMode,
  decodeCodexSpeed,
  isCodexSpeed,
  reconcileCodexSpeedOption,
  type CodexSpeed
} from './codex-structured-speed'
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
      return isCodexTurnOptionKey(key) && (key !== 'speed' || isCodexSpeed(value))
    })
  )
  // A Fast pick saved before speeds existed, or written at rest by an older client.
  const fastMode = restored.get('fastMode')
  restored.delete('fastMode')
  const legacySpeed = fastMode === undefined ? undefined : codexSpeedOfFastMode(fastMode)
  if (!restored.has('speed') && legacySpeed) {
    restored.set('speed', legacySpeed)
  }
  if (!restored.has('speed') && restored.get('serviceTier') === 'default') {
    restored.set('speed', CODEX_STANDARD_SPEED)
  }
  if (restored.has('speed')) {
    restored.delete('serviceTier')
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
      speedTiersByModel: listing.speedTiersByModel,
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
  current: { model?: string; effort?: string; speed?: CodexSpeed }
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
  const speed = decodeCodexSpeed(session.options)
  return composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(speed ? { speed } : {})
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
  reconcileCodexSpeedOption(session, {
    speedTiersByModel: catalog.speedTiersByModel,
    currentSpeed: catalog.result.current.speed,
    model: catalog.result.current.model,
    modelSpeeds: catalog.result.models.find((entry) => entry.id === catalog.result.current.model)
      ?.speeds
  })
  const speed = decodeCodexSpeed(session.options)
  if (speed === undefined) {
    return catalog.result
  }
  const { fastMode: _reported, ...current } = catalog.result.current
  const fastMode = codexFastModeOfSpeed(speed)
  return {
    ...catalog.result,
    current: { ...current, speed, ...(fastMode !== undefined ? { fastMode } : {}) }
  }
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
 * bookkeeping must not gate it. Codex judges the model on `turn/start`, and a speed without a
 * known exact tier sends Standard there.
 */
function applyUnlistedCodexSessionOption(
  session: CodexSession,
  key: 'model' | 'effort' | 'speed',
  value: string
): Readonly<Record<string, string>> {
  if (key === 'speed') {
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
  requestedKey: string,
  requestedValue: string
): Readonly<Record<string, string>> {
  // `serviceTier` still restores, so a session persisted before speeds existed migrates,
  // but the turn now derives the tier from `speed`. Accepting a direct write would
  // report success for a value the next turn discards.
  if (requestedKey === 'serviceTier') {
    throw new Error('codex service tier is derived from the speed and cannot be set directly')
  }
  // An older client still sends its Fast toggle.
  const key = requestedKey === 'fastMode' ? 'speed' : requestedKey
  const value =
    requestedKey === 'fastMode' ? (codexSpeedOfFastMode(requestedValue) ?? '') : requestedValue
  if (key === 'speed' && !isCodexSpeed(value)) {
    throw new Error(`codex has no speed ${requestedValue}`)
  }
  if (key !== 'model' && key !== 'effort' && key !== 'speed') {
    session.options.set(key, requestedValue)
    return Object.fromEntries(session.options)
  }
  if (key === 'speed' && value === CODEX_STANDARD_SPEED) {
    session.options.delete('serviceTier')
    session.options.set('speed', value)
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
  reconcileCodexSpeedOption(session, {
    speedTiersByModel: catalog.speedTiersByModel,
    currentSpeed: catalog.result.current.speed,
    model: priorModel ?? catalog.result.current.model,
    modelSpeeds: catalog.result.models.find(
      (entry) => entry.id === (priorModel ?? catalog.result.current.model)
    )?.speeds
  })
  if (key === 'model' && !catalog.result.models.some((entry) => entry.id === value)) {
    throw new Error(`codex app-server does not offer model ${value}`)
  }
  const modelId = key === 'model' ? value : catalog.result.current.model
  const model = catalog.result.models.find((entry) => entry.id === modelId)
  if (key === 'speed') {
    if (
      !model?.speeds?.some((choice) => choice.value === value) ||
      !catalog.speedTiersByModel.get(modelId)?.[value]
    ) {
      throw new Error(`codex app-server model ${modelId} does not support the ${value} speed`)
    }
    session.options.set('speed', value)
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
  const speed = decodeCodexSpeed(session.options)
  if (
    key === 'model' &&
    speed &&
    speed !== CODEX_STANDARD_SPEED &&
    model?.speeds &&
    !model.speeds.some((choice) => choice.value === speed)
  ) {
    session.options.set('speed', CODEX_STANDARD_SPEED)
  }
  return Object.fromEntries(session.options)
}
