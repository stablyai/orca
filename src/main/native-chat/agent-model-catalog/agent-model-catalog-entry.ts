import type { AgentSessionUnavailable } from '../../../shared/agent-session-availability'
import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'

/** `discovery`: an account-level listing that names the configured default and owns freshness.
 *  `live`: what a running session listed — which models exist and their efforts, nothing more. */
export type AgentModelCatalogSource = 'discovery' | 'live'

/** One successful listing, as any lister hands it to the store. */
export type AgentModelCatalogSuccess = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  fastModeTierByModel: ReadonlyMap<string, string>
  origin: 'live-session' | 'probe'
  /** A row only this session's launch added (its own `--model`): kept only once the account's
   *  catalog already lists that model. */
  launchOnlyModelId?: string
  /** A probe that listed models but also found no chat can start (a signed-out Codex): both kept. */
  unavailable?: AgentSessionUnavailable
}

/** One listing as the store keeps it. */
export type AgentModelCatalogListing = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  /** Provider-advertised Fast tier per model id. */
  fastModeTierByModel: Record<string, string>
  origin: 'live-session' | 'probe'
  at: number
}

/** What a running session listed, as its adapter hands it to the host. Kept here, apart from the
 *  store, so the session wire types don't pull the store's Node-only persistence into clients. */
export type AgentModelCatalogLiveListing = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  /** A row only this session's launch added (its own `--model`): kept only once the account's
   *  catalog already lists that model. */
  launchOnlyModelId?: string
  /** What the agent's own config resolution picked for a session launched with no model pick:
   *  the configured default for that session's config scope. Null when that resolution names no
   *  listed model, so a saved default is stale; absent when this session can't say. */
  configuredDefault?: AgentModelCatalogConfiguredChoice | null
}

/** A configured model as one session resolved it. `effort` is null when the config sends none
 *  and absent when the session picked its own, which says nothing about the config. */
export type AgentModelCatalogConfiguredChoice = {
  modelId: string
  /** Other listed rows that run the same model, and so the same effort. */
  sameModelIds?: string[]
  effort?: string | null
}

/** The account's configured default as an agent's CLI resolved it for a chat with no model pick,
 *  in a workspace with no config of its own; for agents whose listing names none. */
export type AgentModelCatalogConfiguredDefault = {
  modelId: string
  sameModelIds?: string[]
  effort?: string
  at: number
}

/** A live options answer whose model rows are the account's listing as the child reported it,
 *  with what its no-pick launch resolved when the session can say. */
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
  // The merged view every reader uses, derived from the two listings above.
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  fastModeTierByModel: Record<string, string>
  origin: 'live-session' | 'probe'
  fetchedAt: number
}

/** Which models exist and their menus follow the newer listing; the default model and effort are
 *  the CLI-resolved configured default's, else discovery's, else what a live child reported while
 *  its model offers it. */
function mergedModels(
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null,
  configured: AgentModelCatalogConfiguredDefault | null
): AgentSessionModelOption[] {
  const liveIsNewer = live !== null && (discovered === null || live.at >= discovered.at)
  const newer = liveIsNewer ? live : discovered
  const older = liveIsNewer ? discovered : live
  return (newer?.models ?? []).map((model) => {
    const listed = discovered?.models.find((entry) => entry.id === model.id)
    const reported = live?.models.find((entry) => entry.id === model.id)
    const efforts =
      model.efforts.length > 0
        ? model.efforts
        : (older?.models.find((entry) => entry.id === model.id)?.efforts ?? [])
    const runsConfigured =
      configured?.modelId === model.id || configured?.sameModelIds?.includes(model.id) === true
    const configuredEffort = runsConfigured ? configured?.effort : undefined
    const defaultEffort = [configuredEffort, listed?.defaultEffort, reported?.defaultEffort].find(
      (effort) => effort !== undefined && efforts.some((choice) => choice.value === effort)
    )
    const { defaultEffort: _own, ...rest } = model
    return {
      ...rest,
      // A session names no default; without any discovery its own flags are all there is.
      isDefault: configured
        ? model.id === configured.modelId
        : discovered
          ? listed?.isDefault === true
          : model.isDefault,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {})
    }
  })
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
    models: mergedModels(discovered, live, configured),
    ...(fastModeSupport ? { fastModeSupport } : {}),
    fastModeTierByModel: {
      ...live?.fastModeTierByModel,
      ...discovered?.fastModeTierByModel
    },
    origin: newer.origin,
    fetchedAt: newer.at
  }
}

/** The entry `success` makes of `previous`, replacing only the listing of its source. */
export function agentModelCatalogEntryWithSuccess(
  previous: AgentModelCatalogEntry | undefined,
  identity: { agent: string; fingerprint: string },
  success: AgentModelCatalogSuccess,
  source: AgentModelCatalogSource,
  at: number
): AgentModelCatalogEntry | null {
  const launchOnly = success.launchOnlyModelId
  const models =
    launchOnly !== undefined && !previous?.models.some((model) => model.id === launchOnly)
      ? success.models.filter((model) => model.id !== launchOnly)
      : success.models
  if (models.length === 0) {
    // An empty list identifies no model; it is doubt, not a catalog.
    return null
  }
  const listing: AgentModelCatalogListing = {
    models: models.map((model) => ({ ...model })),
    ...(success.fastModeSupport ? { fastModeSupport: success.fastModeSupport } : {}),
    fastModeTierByModel: Object.fromEntries(success.fastModeTierByModel.entries()),
    origin: success.origin,
    at
  }
  const { agent, fingerprint } = identity
  const configured = previous?.configured ?? null
  return source === 'discovery'
    ? agentModelCatalogEntry(agent, fingerprint, listing, previous?.live ?? null, configured)
    : agentModelCatalogEntry(agent, fingerprint, previous?.discovered ?? null, listing, configured)
}

/** A choice as the store keeps it: one that says nothing of effort keeps the saved effort of the
 *  same model, since only the session's own pick hid it. */
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

/** `entry` with `choice` as its configured default (null forgets it); null when nothing changes. */
export function entryWithConfiguredDefault(
  entry: AgentModelCatalogEntry,
  choice: AgentModelCatalogConfiguredChoice | null,
  at: number
): AgentModelCatalogEntry | null {
  const next = configuredDefaultFacts(choice, entry.configured)
  if (JSON.stringify(next) === JSON.stringify(configuredDefaultFacts(entry.configured))) {
    return null
  }
  return agentModelCatalogEntry(
    entry.agent,
    entry.fingerprint,
    entry.discovered,
    entry.live,
    next && { ...next, at }
  )
}

/** What a saved entry says, without its clocks: an unchanged key needs no write to disk. */
export function agentModelCatalogListingKey(entry: AgentModelCatalogEntry): string {
  const facts = (listing: AgentModelCatalogListing | null): unknown =>
    listing && [
      listing.origin,
      listing.models,
      listing.fastModeSupport ?? null,
      listing.fastModeTierByModel
    ]
  return JSON.stringify([
    facts(entry.discovered),
    facts(entry.live),
    configuredDefaultFacts(entry.configured)
  ])
}
