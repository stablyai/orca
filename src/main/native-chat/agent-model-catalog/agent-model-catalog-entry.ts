import {
  configuredDeclarationModels,
  mergedAgentModelCatalogModels
} from './agent-model-catalog-models'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import type { AgentSessionUnavailable } from '../../../shared/agent-session-availability'
import type {
  AgentSessionFastModeSupport,
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'

/** Discovery owns configured defaults/freshness; live listings supply membership and effort menus. */
export type AgentModelCatalogSource = 'discovery' | 'live'

export type AgentModelCatalogSuccess = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  origin: 'live-session' | 'probe'
  complete?: boolean
  configured?: { model?: string; effort?: string }
  /** Launch-injected rows require independent account-catalog membership. */
  launchOnlyModelId?: string
  /** Successful model listings can still report that chats cannot start. */
  unavailable?: AgentSessionUnavailable
}

export type AgentModelCatalogListing = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  origin: 'live-session' | 'probe'
  at: number
  complete?: boolean
}

// Keep wire types independent of the store's Node-only persistence.
export type AgentModelCatalogLiveListing = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  /** Launch-injected rows require independent account-catalog membership. */
  launchOnlyModelId?: string
  /** null invalidates a stale default; absent means the session cannot resolve one. */
  configuredDefault?: AgentModelCatalogConfiguredChoice | null
}

/** null effort means config sets none; absent means a session pick obscured config. */
export type AgentModelCatalogConfiguredChoice = {
  modelId: string
  sameModelIds?: string[]
  effort?: string | null
}

/** CLI-resolved account default from a workspace without project overrides. */
export type AgentModelCatalogConfiguredDefault = {
  modelId: string
  sameModelIds?: string[]
  effort?: string
  at: number
}

/** Report defaults only for config-resolved launches; undefined is unknown, null is unlisted. */
export function unpickedSessionConfiguredChoice(session: {
  resolvesConfig: boolean
  picked?: ReadonlySet<string>
  models: readonly { id: string }[]
  current: { model?: string; effort?: string }
}): AgentModelCatalogConfiguredChoice | null | undefined {
  const { models, current } = session
  // Empty/signed-out listings cannot establish catalog membership.
  if (
    !session.resolvesConfig ||
    session.picked?.has('model') ||
    !current.model ||
    models.length === 0
  ) {
    return undefined
  }
  if (!models.some((model) => model.id === current.model)) {
    return null
  }
  return {
    modelId: current.model,
    // Session effort picks do not establish configured defaults.
    ...(session.picked?.has('effort') ? {} : { effort: current.effort ?? null })
  }
}

export function withLiveCatalogListing<
  T extends Pick<AgentModelCatalogLiveListing, 'models' | 'fastModeSupport'>
>(
  options: T,
  configuredDefault?: AgentModelCatalogConfiguredChoice | null
): T & { catalogListing: AgentModelCatalogLiveListing } {
  return {
    ...options,
    catalogListing: {
      models: options.models,
      ...(options.fastModeSupport ? { fastModeSupport: options.fastModeSupport } : {}),
      ...(configuredDefault !== undefined ? { configuredDefault } : {})
    }
  }
}

export type AgentModelCatalogEntry = {
  agent: string
  fingerprint: string
  discovered: AgentModelCatalogListing | null
  live: AgentModelCatalogListing | null
  configured: AgentModelCatalogConfiguredDefault | null
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  origin: 'live-session' | 'probe'
  fetchedAt: number
}

export function agentModelCatalogResultFromEntry(
  entry: AgentModelCatalogEntry,
  namesDefault: boolean,
  listingNamesConfiguredModel: boolean,
  useConfigured = true
): Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }> {
  const namesConfigured =
    listingNamesConfiguredModel || (useConfigured && entry.configured !== null)
  const models = useConfigured ? entry.models : (entry.discovered?.models ?? entry.models)
  return {
    origin: entry.origin,
    models: models.map((model) => (namesDefault ? { ...model } : { ...model, isDefault: false })),
    ...(entry.fastModeSupport ? { fastModeSupport: entry.fastModeSupport } : {}),
    fetchedAt: entry.fetchedAt,
    listingNamesConfiguredModel: namesDefault && namesConfigured
  }
}

export function agentModelCatalogEntry(
  agent: string,
  fingerprint: string,
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null,
  configured: AgentModelCatalogConfiguredDefault | null
): AgentModelCatalogEntry | null {
  const newer = live && (!discovered || live.at >= discovered.at) ? live : discovered
  if (!newer) {
    return null
  }
  const older = newer === live ? discovered : live
  const fastModeSupport = newer.fastModeSupport ?? older?.fastModeSupport
  return {
    agent,
    fingerprint,
    discovered,
    live,
    configured,
    models: mergedAgentModelCatalogModels(discovered, live, configured).map((model) =>
      independentAgentModelCatalog(agent) && discovered?.complete !== true
        ? { ...model, isDefault: false }
        : model
    ),
    ...(fastModeSupport ? { fastModeSupport } : {}),
    origin: newer.origin,
    fetchedAt: newer.at
  }
}

export function retainedAgentModelCatalogModels(
  _previous: Pick<AgentModelCatalogEntry, 'models'> | null | undefined,
  listing: AgentModelCatalogLiveListing
): AgentSessionModelOption[] {
  return listing.models
}

export function agentModelCatalogEntryWithSuccess(
  previous: AgentModelCatalogEntry | undefined,
  identity: { agent: string; fingerprint: string },
  success: AgentModelCatalogSuccess,
  source: AgentModelCatalogSource,
  at: number
): AgentModelCatalogEntry | null {
  if (independentAgentModelCatalog(identity.agent)) {
    if (source !== 'discovery' || success.models.length === 0) {
      return null
    }
    if (success.complete !== true && previous?.discovered?.complete === true) {
      return previous
    }
    const configuredModel = success.complete === true ? success.configured?.model : undefined
    const configuredRow = configuredModel
      ? success.models.find(
          (row) => row.id === configuredModel || row.resolvedModel === configuredModel
        )
      : undefined
    return agentModelCatalogEntry(
      identity.agent,
      identity.fingerprint,
      {
        models: configuredDeclarationModels(
          success.models.map((row) => ({ ...row })),
          configuredModel
            ? { modelId: configuredRow?.id ?? configuredModel, effort: success.configured?.effort }
            : undefined
        ),
        origin: success.origin,
        at,
        complete: success.complete === true,
        ...(success.fastModeSupport ? { fastModeSupport: success.fastModeSupport } : {})
      },
      null,
      configuredModel
        ? {
            modelId: configuredRow?.id ?? configuredModel,
            at,
            ...(success.configured?.effort ? { effort: success.configured.effort } : {})
          }
        : null
    )
  }
  const models = retainedAgentModelCatalogModels(previous, success)
  if (models.length === 0) {
    return null
  }
  const { agent, fingerprint } = identity
  const listing: AgentModelCatalogListing = {
    models: configuredDeclarationModels(
      models.map((model) => ({ ...model })),
      agent === 'pi' && source === 'discovery' && success.configured?.model
        ? { modelId: success.configured.model, effort: success.configured.effort }
        : undefined
    ),
    ...(success.fastModeSupport ? { fastModeSupport: success.fastModeSupport } : {}),
    origin: success.origin,
    at
  }
  let configured = previous?.configured ?? null
  if (agent === 'pi' && source === 'discovery') {
    const { model, effort } = success.configured ?? {}
    if (model) {
      const facts = configuredDefaultFacts({ modelId: model, effort }, configured)
      configured = facts && { ...facts, at }
    }
    return agentModelCatalogEntry(agent, fingerprint, listing, null, configured)
  }
  return source === 'discovery'
    ? agentModelCatalogEntry(agent, fingerprint, listing, previous?.live ?? null, configured)
    : agentModelCatalogEntry(agent, fingerprint, previous?.discovered ?? null, listing, configured)
}

/** Preserve effort for the same model when a session pick obscures its configured value. */
function configuredDefaultFacts(
  choice: AgentModelCatalogConfiguredChoice | null,
  previous: AgentModelCatalogConfiguredDefault | null = null
): Omit<AgentModelCatalogConfiguredDefault, 'at'> | null {
  if (!choice) {
    return null
  }
  const effort =
    choice.effort === undefined
      ? previous?.modelId === choice.modelId
        ? previous.effort
        : undefined
      : (choice.effort ?? undefined)
  return {
    modelId: choice.modelId,
    ...(choice.sameModelIds?.length ? { sameModelIds: [...choice.sameModelIds] } : {}),
    ...(effort ? { effort } : {})
  }
}

export function entryWithConfiguredDefault(
  entry: AgentModelCatalogEntry,
  choice: AgentModelCatalogConfiguredChoice | null,
  at: number,
  source: AgentModelCatalogListing | null = entry.live
): AgentModelCatalogEntry | null {
  if (independentAgentModelCatalog(entry.agent)) {
    return null
  }
  const next = configuredDefaultFacts(choice, entry.configured)
  const { agent, fingerprint, discovered, live } = entry
  const models =
    live && live === source ? configuredDeclarationModels(live.models, choice) : live?.models
  const samePolicy =
    JSON.stringify(next) === JSON.stringify(configuredDefaultFacts(entry.configured))
  if (samePolicy && models === live?.models) {
    return null
  }
  return agentModelCatalogEntry(
    agent,
    fingerprint,
    discovered,
    live && models && models !== live.models ? { ...live, models } : live,
    samePolicy ? entry.configured : next && { ...next, at }
  )
}

/** Display observations share listing lifetime but are never durable facts. */
export function serializedAgentModelCatalogListing(
  listing: AgentModelCatalogListing | null
): AgentModelCatalogListing | null {
  return (
    listing && {
      ...listing,
      models: listing.models.map(({ declaredDefaultEffort: _declaration, ...model }) => model)
    }
  )
}

/** Exclude clocks so unchanged catalog facts do not trigger disk writes. */
export function agentModelCatalogListingKey(entry: AgentModelCatalogEntry): string {
  const facts = (listing: AgentModelCatalogListing | null): unknown =>
    listing && [
      listing.origin,
      serializedAgentModelCatalogListing(listing)?.models,
      listing.fastModeSupport ?? null,
      listing.complete ?? null
    ]
  return JSON.stringify([
    facts(entry.discovered),
    facts(entry.live),
    configuredDefaultFacts(entry.configured)
  ])
}
