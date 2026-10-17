import type { AgentSessionUnavailable } from '../../../shared/agent-session-availability'
import type {
  AgentSessionFastModeSupport,
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'

/** `discovery`: an account-level listing that names the configured default and owns freshness.
 *  `live`: what a running session listed, including any default it names. */
export type AgentModelCatalogSource = 'discovery' | 'live'

/** One successful listing, as any lister hands it to the store. */
export type AgentModelCatalogSuccess = {
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
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
  origin: 'live-session' | 'probe'
  /** Receipt time and wire `fetchedAt`; restored live values encode relative authority. */
  at: number
  /** Producer rank: process start, probe request, or 0 when unknown; in memory only.
   *  It precedes receipt order because an older child can answer after a newer one. */
  startedAt: number
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

/** What a session that resolves its agent's own config reports as that scope's configured default:
 *  only a new session that restored no model pick and was sent none runs it. Undefined when the
 *  session can't say (it listed or runs no model); null when it runs a model it didn't list. */
export function unpickedSessionConfiguredChoice(session: {
  resolvesConfig: boolean
  picked: ReadonlySet<string>
  models: readonly { id: string }[]
  current: { model?: string; effort?: string }
}): AgentModelCatalogConfiguredChoice | null | undefined {
  const { models, current } = session
  // An empty listing (a signed-out agent) is doubt, not a catalog.
  if (
    !session.resolvesConfig ||
    session.picked.has('model') ||
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
    // An effort this session picked is its own and says nothing of the config's.
    ...(session.picked.has('effort') ? {} : { effort: current.effort ?? null })
  }
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
  /** When the chat that last set or forgot `configured` started; in memory only. */
  configuredStartedAt: number
  // The merged view every reader uses, derived from the two listings above.
  models: AgentSessionModelOption[]
  fastModeSupport?: AgentSessionFastModeSupport
  origin: 'live-session' | 'probe'
  fetchedAt: number
}

export function agentModelCatalogResultFromEntry(
  entry: AgentModelCatalogEntry,
  namesDefault: boolean,
  listingNamesConfiguredModel: boolean
): Exclude<AgentSessionModelCatalogResult, { origin: 'unknown' }> {
  const configured = entry.configured
  // A CLI-resolved default names the configured model even where the listing names none.
  const namesConfigured =
    listingNamesConfiguredModel ||
    (configured !== null && entry.models.some((model) => model.id === configured.modelId))
  return {
    origin: entry.origin,
    // Without a default the picker names nothing until the chat reports its model.
    models: entry.models.map((model) =>
      namesDefault ? { ...model } : { ...model, isDefault: false }
    ),
    ...(entry.fastModeSupport ? { fastModeSupport: entry.fastModeSupport } : {}),
    fetchedAt: entry.fetchedAt,
    listingNamesConfiguredModel: namesDefault && namesConfigured
  }
}

/** The later-started producer's listing leads; a tie goes to the later arrival, live first. */
export function liveLeads(
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null
): live is AgentModelCatalogListing {
  return (
    live !== null &&
    (discovered === null ||
      live.startedAt > discovered.startedAt ||
      (live.startedAt === discovered.startedAt && live.at >= discovered.at))
  )
}

/** Which models exist, their menus and the default follow the newer listing; the configured
 *  default joins only rows that name it. The default effort is the configured default's, else
 *  discovery's, else what a live child reported while its model offers it. */
function mergedModels(
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null,
  configured: AgentModelCatalogConfiguredDefault | null
): AgentSessionModelOption[] {
  const liveIsNewer = liveLeads(discovered, live)
  const newer = liveIsNewer ? live : discovered
  const older = liveIsNewer ? discovered : live
  const joined =
    configured && newer?.models.some((model) => model.id === configured.modelId) ? configured : null
  // A positive live default is authoritative; listings that name none keep discovery's flags.
  const defaults =
    liveIsNewer && newer?.models.some((model) => model.isDefault) ? live : (discovered ?? live)
  return (newer?.models ?? []).map((model) => {
    const listed = discovered?.models.find((entry) => entry.id === model.id)
    const reported = live?.models.find((entry) => entry.id === model.id)
    const olderEfforts = older?.models.find((entry) => entry.id === model.id)?.efforts ?? []
    const runsConfigured =
      joined?.modelId === model.id || joined?.sameModelIds?.includes(model.id) === true
    const configuredEffort = runsConfigured ? joined?.effort : undefined
    const offersConfigured = (menu: AgentSessionModelOption['efforts']): boolean =>
      menu.some((choice) => choice.value === configuredEffort)
    // A coarser newer probe menu (Pi's stops at high) must not drop the effort a chat ran; only the
    // chat's own menu is trusted over it, never an older probe's.
    const keepsChatMenu =
      older === live && !offersConfigured(model.efforts) && offersConfigured(olderEfforts)
    const efforts = model.efforts.length > 0 && !keepsChatMenu ? model.efforts : olderEfforts
    const defaultEffort = [configuredEffort, listed?.defaultEffort, reported?.defaultEffort].find(
      (effort) => effort !== undefined && efforts.some((choice) => choice.value === effort)
    )
    const { defaultEffort: _own, ...rest } = model
    return {
      ...rest,
      isDefault: joined
        ? model.id === joined.modelId
        : defaults?.models.find((entry) => entry.id === model.id)?.isDefault === true,
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
  configured: AgentModelCatalogConfiguredDefault | null,
  configuredStartedAt: number
): AgentModelCatalogEntry | null {
  const newer = liveLeads(discovered, live) ? live : discovered
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
    configuredStartedAt,
    models: mergedModels(discovered, live, configured),
    ...(fastModeSupport ? { fastModeSupport } : {}),
    origin: newer.origin,
    fetchedAt: newer.at
  }
}

/** Only a launch-added row needs independent account membership; ordinary incoming rows stand. */
export function retainedAgentModelCatalogModels(
  previous: Pick<AgentModelCatalogEntry, 'models'> | null | undefined,
  listing: AgentModelCatalogLiveListing
): AgentSessionModelOption[] {
  const launchOnly = listing.launchOnlyModelId
  return launchOnly !== undefined && !previous?.models.some((model) => model.id === launchOnly)
    ? listing.models.filter((model) => model.id !== launchOnly)
    : listing.models
}

/** `models` with each empty menu filled from `known`'s row of the same id. */
function withKnownMenus(
  models: AgentSessionModelOption[],
  known: readonly AgentSessionModelOption[] = []
): AgentSessionModelOption[] {
  return models.map((model) => {
    const efforts = known.find((entry) => entry.id === model.id)?.efforts ?? []
    return model.efforts.length > 0 || efforts.length === 0 ? model : { ...model, efforts }
  })
}

/** The entry `success` makes of `previous`, replacing only the listing of its source, and only
 *  when its producer started no earlier than the held listing's. */
export function agentModelCatalogEntryWithSuccess(
  previous: AgentModelCatalogEntry | undefined,
  identity: { agent: string; fingerprint: string },
  success: AgentModelCatalogSuccess,
  source: AgentModelCatalogSource,
  clock: Pick<AgentModelCatalogListing, 'at' | 'startedAt'>
): AgentModelCatalogEntry | null {
  const models = retainedAgentModelCatalogModels(previous, success)
  if (models.length === 0) {
    // An empty list identifies no model; it is doubt, not a catalog.
    return null
  }
  const incoming: AgentModelCatalogListing = {
    models: models.map((model) => ({ ...model })),
    ...(success.fastModeSupport ? { fastModeSupport: success.fastModeSupport } : {}),
    origin: success.origin,
    ...clock
  }
  const held = (source === 'discovery' ? previous?.discovered : previous?.live) ?? null
  const superseded = held !== null && clock.startedAt < held.startedAt
  let listing = superseded ? held : incoming
  // A session reports only its current model's menu, so an empty one there keeps the known menu.
  if (source === 'live') {
    const other = superseded ? incoming : held
    listing = { ...listing, models: withKnownMenus(listing.models, other?.models) }
  }
  return agentModelCatalogEntry(
    identity.agent,
    identity.fingerprint,
    source === 'discovery' ? listing : (previous?.discovered ?? null),
    source === 'live' ? listing : (previous?.live ?? null),
    previous?.configured ?? null,
    previous?.configuredStartedAt ?? 0
  )
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

/** `entry` with `choice` as its configured default (null forgets it); null when nothing changes
 *  or a chat that started later already set or forgot it. */
export function entryWithConfiguredDefault(
  entry: AgentModelCatalogEntry,
  choice: AgentModelCatalogConfiguredChoice | null,
  clock: { at: number; startedAt: number }
): AgentModelCatalogEntry | null {
  if (clock.startedAt < entry.configuredStartedAt) {
    return null
  }
  const next = configuredDefaultFacts(choice, entry.configured)
  const unchanged =
    JSON.stringify(next) === JSON.stringify(configuredDefaultFacts(entry.configured))
  if (unchanged && clock.startedAt === entry.configuredStartedAt) {
    return null
  }
  return agentModelCatalogEntry(
    entry.agent,
    entry.fingerprint,
    entry.discovered,
    entry.live,
    unchanged ? entry.configured : next && { ...next, at: clock.at },
    clock.startedAt
  )
}

/** Saved facts and relative authority: an unchanged key needs no write to disk. */
export function agentModelCatalogListingKey(entry: AgentModelCatalogEntry): string {
  const facts = (listing: AgentModelCatalogListing | null): unknown =>
    listing && [listing.origin, listing.models, listing.fastModeSupport ?? null]
  return JSON.stringify([
    facts(entry.discovered),
    facts(entry.live),
    liveLeads(entry.discovered, entry.live),
    configuredDefaultFacts(entry.configured)
  ])
}
