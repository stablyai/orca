// Runtime control of the relay edge on the director: director/edge.json in the relay-control
// bucket, read by the shared flag channel (relay-control-flag-channel.ts), so a
// rollout step or a rollback needs no director deploy. Boot uses the defaults (mode on, the env
// rollout percent); a failed read keeps the last applied flags.
import { z } from 'zod'
import { RELAY_REGIONS, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import {
  startControlFlagChannel,
  type ControlFlagParse
} from './relay-control-flag-channel.js'

// `off`: no host is in the cohort; hosts on the edge leave normally (export, place, fence) and the
// evacuation sweep drains them. `down`: as off, and the edge is known dead, so a leaving host's
// export is skipped at once (EdgeAssignments.leaveEdge).
export type EdgeControlMode = 'on' | 'off' | 'down'

export type EdgeControlFlags = {
  mode: EdgeControlMode
  // Replaces the env rollout percent when present (1‰ steps).
  rolloutPermille?: number
  // Highest rollout (permille) ever applied. Present: a host above it (and above the current
  // rollout, and on no allow or deny list) cannot have a row on the edge, so its asks skip the
  // edge row read (mayBeOnEdge). Absent: every host's ask reads it. Operating rules:
  // - never lower it below a rollout that was applied (a file with it below rolloutPermille is void);
  // - raise it in its own write, at least a minute (many polls) before a higher rollout, so no
  //   director still skips a host another director has just moved;
  // - unset it before removing an allow list entry (the ceiling covers buckets, not the lists).
  leaveCeilingPermille?: number
  // Per region rollout (permille), by the region the host asks for. A listed region is in scope
  // even when ORCA_RELAY_EDGE_REGIONS omits it; 0 admits only allow-listed hosts and accounts.
  // Unlisted regions keep the global rollout when in ORCA_RELAY_EDGE_REGIONS, else stay out.
  regionRolloutPermille?: Partial<Record<RelayRegion, number>>
  // Countries (ISO 3166 alpha-2, from the director's offline IP lookup) whose hosts never join
  // the cohort of that region; allow-listed hosts still do, allow-listed accounts do not.
  regionExcludeCountries?: Partial<Record<RelayRegion, string[]>>
  // Per region: a host whose country is unknown (no database, a miss, an unparsable hop) is
  // excluded too. Default false: an unknown country joins, so a gap in the database can let a
  // host of an excluded country in; true keeps those out at the cost of every unknown host.
  regionExcludeUnknownCountry?: Partial<Record<RelayRegion, boolean>>
  // A host on the edge whose ask comes from one of `countries`, or whose id is in `hosts`, is
  // answered with `url` (a front door in ORCA_RELAY_EDGE_FRONT_DOOR_URLS) instead of the edge's
  // own URL. Sticky: a host switches only on a real reconnect or a move onto the edge, at a newer
  // epoch (EdgeRoute in edge-relay.ts, which also states the mixed-version operating rule). A
  // region's country exclusion wins over `countries`: an excluded host is never answered it by
  // country. A host listed in `hosts` is an operator's choice for that one host: it is in the edge
  // cohort (inEdgeCohort) and answered `url` whatever its country, exclusion included, so an
  // excluded country's host can reach the edge only through the front door. Dropping it from the
  // list puts it back under the exclusion and rollout (an excluded host leaves the edge at its next
  // ask or, when its bucket is above the rollout, the evacuation sweep; one under it stays until its
  // control drops). Like removing an allow list entry, only remove a host while leaveCeilingPermille
  // is unset or above its bucket, or its asks skip the leave and lose its edge-only devices. List a
  // host only while every serving director carries the same ORCA_RELAY_EDGE_FRONT_DOOR_URLS: one
  // without it answers a listed live host the edge's own URL (stayOnEdge). Absent: no host is newly mapped, and mapped hosts return to the
  // edge URL on their next reconnect. A bad value drops only this key (reported in ignoredKeys);
  // the rest of the object still applies.
  frontDoor?: EdgeFrontDoorFlag
  // Ramps a country the region excludes onto the front door: a host whose ask comes from one of
  // frontDoor.countries, in a region that excludes that country, joins the cohort and is answered
  // frontDoor.url when its cohort bucket is under both this value and the region's rollout (so the
  // evacuation sweep, which sees no country, keeps it). Absent (also when no front door applies):
  // the exclusion wins, as before. Lowering it is not a fast rollback: a host above the new value
  // leaves only at its next ask that is not kept live (stayOnEdge), up to a control's lifetime;
  // the immediate levers stay mode and deny hosts. Its own key, so an older director drops only it
  // (ignoredKeys) and keeps its frontDoor; set it once every serving director carries it, and
  // remove it before rolling back to one that does not. A bad value drops only this key (reported
  // in ignoredKeys) and keeps the last applied one.
  frontDoorCountryRolloutPermille?: number
  // How a regionless ask is judged. 'ask' (also when absent): as RELAY_DEFAULT_REGION, so with
  // regional rollouts that differ, a host whose region-naming asks (the initial open, the drain
  // reconnect) name another region moves on and off the edge at every regionless one (the shipped
  // desktop's hourly region refresh). 'host': a regionless ask never moves a host onto the edge;
  // one of a host on the edge is judged by the region its last region-naming ask recorded
  // (relay_edge_host_regions, which it leaves unchanged), whatever its country exclusion or front
  // door says for that region. Asks naming a region are judged and recorded exactly as under
  // 'ask'. For a fixed set of flags and a desktop whose preferred region holds, a host then never
  // flips, and the evacuation sweep judges every edge host by its record, as the assign path
  // does. A host whose desktop never names a region never joins under 'host'. Set it only once
  // every serving director carries it: an older one ignores it (ignoredKeys) and keeps judging by
  // the ask. A bad value drops only this key (reported in ignoredKeys) and keeps the last applied
  // one.
  cohortRegion?: EdgeCohortRegion
  // Which edge hosts get AssignmentResponse.alternateCellUrls, the other origin that reaches the
  // same edge object (front door ↔ the edge's own URL), so a desktop can fail over between them
  // without a director ask. Only an ask carrying the origin-alternates-v1 host capability gets the
  // field at all (shipped desktops parse the answer strictly). 'off' (also when absent): nobody.
  // 'listed': a host frontDoor lists by id. 'country': any host frontDoor maps (by id or by
  // country), and any host answered through an allowed front door. Derived from the flags and
  // ORCA_RELAY_EDGE_FRONT_DOOR_URLS on every ask, with no epoch or row write; without that env
  // nobody gets it. A bad value drops only this key (reported in ignoredKeys) and keeps the last
  // applied one. An older director ignores the key (ignoredKeys) and never sends the field.
  alternates?: EdgeAlternates
  // Whether a host answered through an allowed front door gets AssignmentResponse.authOrigin (that
  // front door's origin), so the desktop can renew its relay token through it when the auth domain
  // is unreachable. Only an ask carrying the front-door-auth-v1 host capability gets the field.
  // 'off' (also when absent): nobody. 'on': every capable host whose answered cellUrl is in
  // ORCA_RELAY_EDGE_FRONT_DOOR_URLS. A bad value drops only this key (reported in ignoredKeys) and
  // keeps the last applied one. An older director ignores the key and never sends the field.
  frontDoorAuth?: EdgeFrontDoorAuth
  // Whether a host's own ask may move it onto the edge while its old cell still holds its own
  // control unit (EdgeAssignments.moveToEdge): exactly one control unit backed by one control lease
  // on the row's cell, nothing else held, no open migration or rehome. The move takes that unit
  // off the old cell; any splice, invite, install, confirmation or migration still defers it.
  // 'off' (also when absent): every held unit defers the move, as before. 'drain': only on a
  // reconnect ask without regionCorrection (the shipped desktop's drain or lost-control path, whose
  // control on the old cell is already gone or going). No mode moves a host on an ask its desktop
  // makes while still connected (the initial open, the hourly region refresh): a reserve-mode cell
  // admits controls from memory with no lease to renew, so nothing would close that control for up
  // to the ledger's reconcile interval while its phones resolve to the edge. A bad value drops only
  // this key (reported in ignoredKeys) and keeps the last applied one. An older director ignores
  // the key (ignoredKeys).
  // 'drain-stale' also moves, on the same asks, a host whose row holds counters no lease backs on
  // a reserve-mode cell: the expiry sweep never clears those (it skips reserve cells), so they would
  // defer the host's move forever. The move zeroes them and leaves the old cell's reservation
  // counter alone.
  moveOwnControl?: EdgeMoveOwnControl
}

export type EdgeMoveOwnControl = 'off' | 'drain' | 'drain-stale'

export type EdgeCohortRegion = 'ask' | 'host'

export type EdgeAlternates = 'off' | 'listed' | 'country'

export type EdgeFrontDoorAuth = 'off' | 'on'

export type EdgeFrontDoorFlag = { url: string; countries?: string[]; hosts?: string[] }

export const EDGE_CONTROL_DEFAULTS: EdgeControlFlags = { mode: 'on' }
export const EDGE_CONTROL_OBJECT_NAME = 'director/edge.json'
export const EDGE_CONTROL_APPLIED_EVENT = 'orca_relay_edge_control_applied'

const permille = z.number().int().min(0).max(1_000)
// An unknown region key voids the object, like any bad value.
const regionKey = z.enum(RELAY_REGIONS)
const EdgeControlFlagsSchema = z.object({
  mode: z.enum(['on', 'off', 'down']).default(EDGE_CONTROL_DEFAULTS.mode),
  rolloutPermille: permille.optional(),
  leaveCeilingPermille: permille.optional(),
  regionRolloutPermille: z.partialRecord(regionKey, permille).optional(),
  regionExcludeCountries: z
    // Upper-cased first, so a lower-case code is not a typo that voids the whole file.
    .partialRecord(regionKey, z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(250))
    .optional(),
  regionExcludeUnknownCountry: z.partialRecord(regionKey, z.boolean()).optional(),
  frontDoor: z.unknown().optional(),
  cohortRegion: z.unknown().optional(),
  alternates: z.unknown().optional(),
  frontDoorAuth: z.unknown().optional(),
  frontDoorCountryRolloutPermille: z.unknown().optional(),
  moveOwnControl: z.unknown().optional()
})
const EdgeCohortRegionSchema = z.enum(['ask', 'host'])
const EdgeAlternatesSchema = z.enum(['off', 'listed', 'country'])
const EdgeFrontDoorAuthSchema = z.enum(['off', 'on'])
const EdgeMoveOwnControlSchema = z.enum(['off', 'drain', 'drain-stale'])
const EdgeFrontDoorSchema = z
    .object({
      // A bare https origin; that it is an allowed front door is checked against the boot list.
      url: z.string().refine((url) => URL.canParse(url) && new URL(url).protocol === 'https:' && new URL(url).origin === url),
      countries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(250).optional(),
      hosts: z.array(z.string().regex(/^[A-Za-z0-9_-]{16}$/)).max(1_000).optional()
    })
    .strict()
// A trailing slash is the same origin, not a typo.
function parseFrontDoor(value: unknown): EdgeFrontDoorFlag | null {
  const normalized =
    value !== null && typeof value === 'object' && 'url' in value && typeof value.url === 'string'
      ? { ...value, url: value.url.replace(/\/$/, '') }
      : value
  const parsed = EdgeFrontDoorSchema.safeParse(normalized)
  return parsed.success ? parsed.data : null
}
const KNOWN_FLAG_KEYS = new Set(Object.keys(EdgeControlFlagsSchema.shape))
const EdgeControlObjectSchema = z.object({
  v: z.literal(1),
  // A ceiling below any rollout it must cover (global or regional) voids the object.
  flags: EdgeControlFlagsSchema.refine(
    (flags) =>
      flags.leaveCeilingPermille === undefined ||
      [flags.rolloutPermille, ...Object.values(flags.regionRolloutPermille ?? {})].every(
        (rollout) => rollout === undefined || flags.leaveCeilingPermille! >= rollout
      )
  )
})

// Unknown keys (a newer writer's, or a typo) are dropped and reported; a known key with a bad value
// voids the whole object, so the last applied flags stay.
export const parseEdgeControl: ControlFlagParse<EdgeControlFlags> = (body) => parseEdgeControlOver(body, undefined)

// As parseEdgeControl, with the flags applied now: a bad frontDoor (cohortRegion, alternates, frontDoorAuth, moveOwnControl) keeps the last good one (as a bad
// file keeps the last applied flags), reported in ignoredKeys; the rest of the object applies.
export function parseEdgeControlOver(
  body: unknown,
  previous: EdgeControlFlags | undefined
): ReturnType<ControlFlagParse<EdgeControlFlags>> {
  const parsed = EdgeControlObjectSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const named = body !== null && typeof body === 'object' && 'flags' in body ? body.flags : {}
  const ignoredKeys =
    named !== null && typeof named === 'object'
      ? Object.keys(named).filter((key) => !KNOWN_FLAG_KEYS.has(key))
      : []
  const {
    mode,
    rolloutPermille,
    leaveCeilingPermille,
    regionRolloutPermille,
    regionExcludeCountries,
    regionExcludeUnknownCountry,
    frontDoor: rawFrontDoor,
    cohortRegion: rawCohortRegion,
    alternates: rawAlternates,
    frontDoorAuth: rawFrontDoorAuth,
    frontDoorCountryRolloutPermille: rawCountryRollout,
    moveOwnControl: rawMoveOwnControl
  } = parsed.data.flags
  const frontDoor = rawFrontDoor === undefined ? undefined : parseFrontDoor(rawFrontDoor)
  if (frontDoor === null) { ignoredKeys.push('frontDoor') }
  const keptFrontDoor = frontDoor === null ? previous?.frontDoor : frontDoor
  const cohortRegion = rawCohortRegion === undefined ? undefined : EdgeCohortRegionSchema.safeParse(rawCohortRegion)
  if (cohortRegion?.success === false) { ignoredKeys.push('cohortRegion') }
  const keptCohortRegion = cohortRegion === undefined ? undefined : cohortRegion.success ? cohortRegion.data : previous?.cohortRegion
  const alternates = rawAlternates === undefined ? undefined : EdgeAlternatesSchema.safeParse(rawAlternates)
  if (alternates?.success === false) { ignoredKeys.push('alternates') }
  const keptAlternates = alternates === undefined ? undefined : alternates.success ? alternates.data : previous?.alternates
  const frontDoorAuth = rawFrontDoorAuth === undefined ? undefined : EdgeFrontDoorAuthSchema.safeParse(rawFrontDoorAuth)
  if (frontDoorAuth?.success === false) { ignoredKeys.push('frontDoorAuth') }
  const keptFrontDoorAuth =
    frontDoorAuth === undefined ? undefined : frontDoorAuth.success ? frontDoorAuth.data : previous?.frontDoorAuth
  const countryRollout = rawCountryRollout === undefined ? undefined : permille.safeParse(rawCountryRollout)
  if (countryRollout?.success === false) { ignoredKeys.push('frontDoorCountryRolloutPermille') }
  const keptCountryRollout =
    countryRollout === undefined
      ? undefined
      : countryRollout.success
        ? countryRollout.data
        : previous?.frontDoorCountryRolloutPermille
  const moveOwnControl = rawMoveOwnControl === undefined ? undefined : EdgeMoveOwnControlSchema.safeParse(rawMoveOwnControl)
  if (moveOwnControl?.success === false) { ignoredKeys.push('moveOwnControl') }
  const keptMoveOwnControl =
    moveOwnControl === undefined ? undefined : moveOwnControl.success ? moveOwnControl.data : previous?.moveOwnControl
  ignoredKeys.sort()
  return {
    flags: {
      mode,
      ...(rolloutPermille === undefined ? {} : { rolloutPermille }),
      ...(leaveCeilingPermille === undefined ? {} : { leaveCeilingPermille }),
      ...(regionRolloutPermille === undefined ? {} : { regionRolloutPermille }),
      ...(regionExcludeCountries === undefined ? {} : { regionExcludeCountries }),
      ...(regionExcludeUnknownCountry === undefined ? {} : { regionExcludeUnknownCountry }),
      ...(keptFrontDoor === undefined ? {} : { frontDoor: keptFrontDoor }),
      ...(keptCohortRegion === undefined ? {} : { cohortRegion: keptCohortRegion }),
      ...(keptAlternates === undefined ? {} : { alternates: keptAlternates }),
      ...(keptFrontDoorAuth === undefined ? {} : { frontDoorAuth: keptFrontDoorAuth }),
      ...(keptCountryRollout === undefined ? {} : { frontDoorCountryRolloutPermille: keptCountryRollout }),
      ...(keptMoveOwnControl === undefined ? {} : { moveOwnControl: keptMoveOwnControl })
    },
    ignoredKeys
  }
}

export type EdgeControl = {
  // The flags applied now; callers read this on every decision, never caching it.
  flags: () => EdgeControlFlags
  // Called after each newly applied generation.
  onChange: (listener: () => void) => void
  stop: () => void
}

export function startEdgeControl(
  input: { fetch?: typeof fetch; random?: () => number; pollMs?: number; autoStart?: boolean } = {}
): EdgeControl & { poll: () => Promise<void> } {
  const listeners: (() => void)[] = []
  // parse reads the applied flags lazily (the channel exists by the time it polls).
  const applied: { flags: () => EdgeControlFlags | undefined } = { flags: () => undefined }
  const channel = startControlFlagChannel({
    objectName: EDGE_CONTROL_OBJECT_NAME,
    defaults: EDGE_CONTROL_DEFAULTS,
    parse: (body) => parseEdgeControlOver(body, applied.flags()),
    appliedEvent: EDGE_CONTROL_APPLIED_EVENT,
    onApplied: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    ...input
  })
  applied.flags = () => channel.applied().flags
  return {
    flags: () => channel.applied().flags,
    onChange: (listener) => {
      listeners.push(listener)
    },
    poll: channel.poll,
    stop: channel.stop
  }
}

// Effective share of hosts on the edge in permille: the applied flag, else the env percent.
export function edgeRolloutPermille(rolloutPercent: number, flags: EdgeControlFlags): number {
  return flags.rolloutPermille ?? rolloutPercent * 10
}

// Any regional share set: the evacuation sweep judges each edge host by its recorded region
// (relay_edge_host_regions). None: it judges every host 'any' with today's query.
export function edgeRegionalRollout(flags: EdgeControlFlags): boolean {
  return Object.keys(flags.regionRolloutPermille ?? {}).length > 0
}

// Whether a host's cohort is judged by its recorded edge region (cohortRegion 'host').
export function edgeCohortByHost(flags: EdgeControlFlags): boolean {
  return flags.cohortRegion === 'host'
}

// Whether this ask of the host may move it onto the edge past its own control unit on its old cell
// (moveOwnControl). Report asks never reach the move.
export function edgeMoveOwnControlAsk(
  flags: EdgeControlFlags,
  ask: { reconnect?: boolean; regionCorrection?: unknown }
): boolean {
  return (
    (flags.moveOwnControl === 'drain' || flags.moveOwnControl === 'drain-stale') &&
    ask.reconnect === true &&
    ask.regionCorrection === undefined
  )
}

// Whether this ask may also move a host past stale counters on a reserve-mode cell (moveOwnControl
// 'drain-stale'): any ask but a region correction. Unlike taking a live own control, a stale move
// cuts nothing live, so it need not wait for a reconnect ask; older desktops never send one.
export function edgeMoveStaleUnitsAsk(
  flags: EdgeControlFlags,
  ask: { reconnect?: boolean; regionCorrection?: unknown }
): boolean {
  return flags.moveOwnControl === 'drain-stale' && ask.regionCorrection === undefined
}

// Effective rollout for hosts asking for `region`: its regional value, else the global rollout
// when the env scope lists it, else undefined (out of scope).
export function edgeRegionRolloutPermille(
  scope: { rolloutPercent: number; regions: ReadonlySet<RelayRegion> },
  flags: EdgeControlFlags,
  region: RelayRegion
): number | undefined {
  const regional = flags.regionRolloutPermille?.[region]
  if (regional !== undefined) {
    return regional
  }
  return scope.regions.has(region) ? edgeRolloutPermille(scope.rolloutPercent, flags) : undefined
}

// Rollout for a host whose region is not known (the evacuation sweep): the highest of every
// in-scope region's, so no host the assign path would keep is drained. No region in scope (and
// without regional values) is the global rollout, as before regional values existed.
export function edgeAnyRegionRolloutPermille(
  scope: { rolloutPercent: number; regions: ReadonlySet<RelayRegion> },
  flags: EdgeControlFlags
): number {
  const inScope = new Set<RelayRegion>([
    ...scope.regions,
    ...(Object.keys(flags.regionRolloutPermille ?? {}) as RelayRegion[])
  ])
  if (inScope.size === 0) {
    return edgeRolloutPermille(scope.rolloutPercent, flags)
  }
  return Math.max(...[...inScope].map((region) => edgeRegionRolloutPermille(scope, flags, region)!))
}

// Whether the country of an ask keeps the host out of `region`'s cohort. `null`: the ask's country
// is unknown.
export function edgeCountryExcluded(flags: EdgeControlFlags, region: RelayRegion, country: string | null): boolean {
  if (country === null) {
    return flags.regionExcludeUnknownCountry?.[region] === true
  }
  return flags.regionExcludeCountries?.[region]?.includes(country) === true
}

// Whether the flag lists this host by id on a front door in the boot allowlist (`frontDoorUrls`).
export function edgeFrontDoorListsHost(
  flags: EdgeControlFlags,
  frontDoorUrls: ReadonlySet<string> | undefined,
  relayHostId: string
): boolean {
  const door = flags.frontDoor
  return door !== undefined && frontDoorUrls?.has(door.url) === true && door.hosts?.includes(relayHostId) === true
}

// A host's place in the country ramp: its cohort bucket and its region's rollout (undefined: the
// region is out of scope, so nothing is admitted).
export type EdgeFrontDoorRampPosition = { bucketPermille: number; regionalPermille: number | undefined }

// Whether the front door country ramp (frontDoorCountryRolloutPermille) admits a host asking from
// `country` despite its region's exclusion: the country is one of frontDoor.countries, the door is
// on the boot allowlist, and the host's bucket is under both the ramp and the region's rollout.
// The one predicate for admission (inEdgeCohort) and routing (edgeFrontDoorFor).
export function edgeFrontDoorRampAdmits(
  flags: EdgeControlFlags,
  frontDoorUrls: ReadonlySet<string> | undefined,
  country: string | null,
  position: EdgeFrontDoorRampPosition
): boolean {
  const door = flags.frontDoor
  const ramp = flags.frontDoorCountryRolloutPermille
  return (
    ramp !== undefined &&
    door !== undefined &&
    frontDoorUrls?.has(door.url) === true &&
    country !== null &&
    door.countries?.includes(country) === true &&
    position.regionalPermille !== undefined &&
    position.bucketPermille < Math.min(ramp, position.regionalPermille)
  )
}

// The front door a host's ask maps to, or undefined for the edge's own URL. `frontDoorUrls`: the
// boot allowlist (a flag naming any other URL maps nobody). `country` null: unknown, which only a
// host listed by id can be mapped with. `byCountry`: the ask's country matched (not only the id).
// A host listed by id is mapped even when the region excludes its country (see frontDoor).
export function edgeFrontDoorFor(
  flags: EdgeControlFlags,
  frontDoorUrls: ReadonlySet<string> | undefined,
  relayHostId: string,
  region: RelayRegion,
  country: string | null,
  // The host's place in the country ramp; undefined: no ramp applies.
  ramp?: EdgeFrontDoorRampPosition
): { url: string; byCountry: boolean } | undefined {
  const door = flags.frontDoor
  if (door === undefined || frontDoorUrls?.has(door.url) !== true) { return undefined }
  const listed = door.hosts?.includes(relayHostId) === true
  const ramped = ramp !== undefined && edgeFrontDoorRampAdmits(flags, frontDoorUrls, country, ramp)
  if (!listed && !ramped && edgeCountryExcluded(flags, region, country)) { return undefined }
  const byCountry = country !== null && door.countries?.includes(country) === true
  return byCountry || listed ? { url: door.url, byCountry } : undefined
}
