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
}

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
  regionExcludeUnknownCountry: z.partialRecord(regionKey, z.boolean()).optional()
})
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
export const parseEdgeControl: ControlFlagParse<EdgeControlFlags> = (body) => {
  const parsed = EdgeControlObjectSchema.safeParse(body)
  if (!parsed.success) {
    return null
  }
  const named = body !== null && typeof body === 'object' && 'flags' in body ? body.flags : {}
  const ignoredKeys =
    named !== null && typeof named === 'object'
      ? Object.keys(named).filter((key) => !KNOWN_FLAG_KEYS.has(key)).sort()
      : []
  const {
    mode,
    rolloutPermille,
    leaveCeilingPermille,
    regionRolloutPermille,
    regionExcludeCountries,
    regionExcludeUnknownCountry
  } = parsed.data.flags
  return {
    flags: {
      mode,
      ...(rolloutPermille === undefined ? {} : { rolloutPermille }),
      ...(leaveCeilingPermille === undefined ? {} : { leaveCeilingPermille }),
      ...(regionRolloutPermille === undefined ? {} : { regionRolloutPermille }),
      ...(regionExcludeCountries === undefined ? {} : { regionExcludeCountries }),
      ...(regionExcludeUnknownCountry === undefined ? {} : { regionExcludeUnknownCountry })
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
  const channel = startControlFlagChannel({
    objectName: EDGE_CONTROL_OBJECT_NAME,
    defaults: EDGE_CONTROL_DEFAULTS,
    parse: parseEdgeControl,
    appliedEvent: EDGE_CONTROL_APPLIED_EVENT,
    onApplied: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    ...input
  })
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
