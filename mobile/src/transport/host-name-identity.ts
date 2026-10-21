import { GENERATED_HOST_NAME_PATTERN, getNextHostNameFromHosts } from './host-names'
import type { StoredHostProfile } from './types'

/**
 * The rules that keep a stored host's `name` equal to
 * `personalName ?? lastKnownMachineName ?? "Host N"`. Pure: host-store applies them inside its
 * serialized mutation pass, so the resolved name and its sources are always written together.
 * One exception: see `withReportedDescriptor`.
 */

type HostNameIdentity = Pick<
  StoredHostProfile,
  'name' | 'personalName' | 'lastKnownMachineName' | 'lastKnownHostPlatform'
>

export type ReportedHostDescriptor = {
  machineName: string | null
  platform: NodeJS.Platform | null
}

/**
 * Classifies a record written before the name-identity fields existed. Legacy storage held one
 * `name` that was either the generated "Host N" or typed by the user, and only the typed one is an
 * override. Safe to re-run on every parse: any record a current build has written carries at least
 * one of the three fields (clearing an override either restores the machine name — a field — or
 * keeps a generated "Host N", which this pattern skips), so only true legacy records are classified.
 */
export function classifyLegacyHostName<T extends HostNameIdentity>(profile: T): T {
  if (
    profile.personalName !== undefined ||
    profile.lastKnownMachineName !== undefined ||
    profile.lastKnownHostPlatform !== undefined ||
    GENERATED_HOST_NAME_PATTERN.test(profile.name)
  ) {
    return profile
  }
  return { ...profile, personalName: profile.name }
}

/**
 * Why: a save rebuilds the record from a pairing offer (no name identity) or from a connection's
 * profile snapshot (identity as of connect). Only the stored record reflects later renames and
 * descriptor reads, so it keeps the name identity; the save supplies everything else.
 */
export function mergeHostNameIdentity(
  incoming: StoredHostProfile,
  existing: StoredHostProfile
): StoredHostProfile {
  const {
    personalName: _personalName,
    lastKnownMachineName: _machineName,
    lastKnownHostPlatform: _platform,
    ...rest
  } = incoming
  const { personalName, lastKnownMachineName, lastKnownHostPlatform } = existing
  return {
    ...rest,
    name: existing.name,
    ...(personalName !== undefined ? { personalName } : {}),
    ...(lastKnownMachineName !== undefined ? { lastKnownMachineName } : {}),
    ...(lastKnownHostPlatform !== undefined ? { lastKnownHostPlatform } : {})
  }
}

/** Sets the phone's override, or clears it (`null`) to return the row to the desktop's name. */
export function withPersonalName(
  current: StoredHostProfile,
  personalName: string | null,
  hosts: readonly StoredHostProfile[]
): StoredHostProfile {
  if (personalName !== null) {
    return { ...current, personalName, name: personalName }
  }
  const { personalName: _cleared, ...rest } = current
  // Why: with no machine name to fall back to, an already-generated name is kept, not renumbered.
  const fallback = GENERATED_HOST_NAME_PATTERN.test(current.name)
    ? current.name
    : getNextHostNameFromHosts(hosts)
  return { ...rest, name: current.lastKnownMachineName ?? fallback }
}

/**
 * Applies what the desktop reported; returns `current` itself when nothing changed. An answered
 * status is authoritative, so an omitted half clears its last-known value, and an unoverridden
 * row adopts a newly reported machine name as its display name.
 * Exception: an OS reported without a machine name keeps the previously adopted name as `name`.
 */
export function withReportedDescriptor(
  current: StoredHostProfile,
  descriptor: ReportedHostDescriptor
): StoredHostProfile {
  const { lastKnownMachineName: _machineName, lastKnownHostPlatform: _platform, ...rest } = current
  const lastKnownMachineName = descriptor.machineName ?? undefined
  const lastKnownHostPlatform = descriptor.platform ?? undefined
  const name = current.personalName ?? lastKnownMachineName ?? current.name
  if (
    name === current.name &&
    lastKnownMachineName === current.lastKnownMachineName &&
    lastKnownHostPlatform === current.lastKnownHostPlatform
  ) {
    return current
  }
  return {
    ...rest,
    name,
    ...(lastKnownMachineName !== undefined ? { lastKnownMachineName } : {}),
    ...(lastKnownHostPlatform !== undefined ? { lastKnownHostPlatform } : {})
  }
}
