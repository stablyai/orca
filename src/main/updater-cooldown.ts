import { compareVersions } from './updater-fallback'

/**
 * Client-side update cooldown ("release aging"). To resist supply-chain attacks
 * delivered through a compromised release pipeline AND feed, we never trust the
 * server's publish timestamps — the only trust anchors are the device's own
 * clock and its own persisted record of when it first observed a version. An
 * update is withheld until it has been locally observed for the configured
 * cooldown, giving time for a malicious release to be detected and yanked.
 */
export type UpdateFirstSeenLedger = Record<string, number>

export const DEFAULT_UPDATE_COOLDOWN_DAYS = 0
const MS_PER_DAY = 24 * 60 * 60 * 1000
// Why: only versions newer than the installed one can ever gate a future
// update; this caps the persisted ledger so it can't grow without bound.
const MAX_LEDGER_ENTRIES = 50

function parseCooldownDays(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  const days = Number(trimmed)
  if (!Number.isFinite(days) || days < 0) {
    return null
  }
  return days
}

/**
 * Resolve the cooldown window in ms. Precedence: env var > persisted setting >
 * default (0 = disabled). 0 short-circuits all cooldown logic so unconfigured
 * installs behave exactly as before.
 */
export function resolveUpdateCooldownMs(opts: {
  envValue?: string
  settingDays?: number | null
}): number {
  const envDays = parseCooldownDays(opts.envValue)
  const settingDays =
    opts.settingDays != null && Number.isFinite(opts.settingDays) && opts.settingDays >= 0
      ? opts.settingDays
      : null
  const days = envDays ?? settingDays ?? DEFAULT_UPDATE_COOLDOWN_DAYS
  return days > 0 ? days * MS_PER_DAY : 0
}

// Clamp a future timestamp (clock moved backward since first-seen) to now so a
// rewound clock can only lengthen the wait, never shorten it.
function effectiveFirstSeen(firstSeen: number, nowMs: number): number {
  return firstSeen > nowMs ? nowMs : firstSeen
}

/**
 * Stamp `version` with `nowMs` the first time it is observed. Existing earlier
 * stamps are preserved; a future stamp is clamped to now. Returns the same
 * reference when nothing changes so callers can skip a redundant persist.
 */
export function recordVersionFirstSeen(
  ledger: UpdateFirstSeenLedger,
  version: string,
  nowMs: number
): UpdateFirstSeenLedger {
  const existing = ledger[version]
  if (existing === undefined) {
    return { ...ledger, [version]: nowMs }
  }
  const clamped = effectiveFirstSeen(existing, nowMs)
  if (clamped === existing) {
    return ledger
  }
  return { ...ledger, [version]: clamped }
}

export function isVersionEligible(args: {
  ledger: UpdateFirstSeenLedger
  version: string
  nowMs: number
  cooldownMs: number
}): boolean {
  if (args.cooldownMs <= 0) {
    return true
  }
  const firstSeen = args.ledger[args.version]
  if (firstSeen === undefined) {
    return false
  }
  return args.nowMs - effectiveFirstSeen(firstSeen, args.nowMs) >= args.cooldownMs
}

/** When the version becomes installable, or null if not gated/unknown. */
export function eligibleAtMs(args: {
  ledger: UpdateFirstSeenLedger
  version: string
  nowMs: number
  cooldownMs: number
}): number | null {
  if (args.cooldownMs <= 0) {
    return null
  }
  const firstSeen = args.ledger[args.version]
  if (firstSeen === undefined) {
    return null
  }
  return effectiveFirstSeen(firstSeen, args.nowMs) + args.cooldownMs
}

/**
 * Drop ledger entries at or below the installed version (they can never gate a
 * future update) and cap the size, keeping the most recently seen entries.
 */
export function pruneFirstSeenLedger(
  ledger: UpdateFirstSeenLedger,
  currentVersion: string
): UpdateFirstSeenLedger {
  const newer = Object.entries(ledger).filter(
    ([version]) => compareVersions(version, currentVersion) > 0
  )
  const kept =
    newer.length > MAX_LEDGER_ENTRIES
      ? newer.sort((a, b) => b[1] - a[1]).slice(0, MAX_LEDGER_ENTRIES)
      : newer
  return Object.fromEntries(kept)
}
