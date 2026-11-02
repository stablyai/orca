import { GENERATED_HOST_NAME_PATTERN, getNextHostNameFromHosts } from './host-names'
import type { StoredHostProfile } from './types'

// Resolve name identity inside host-store’s serialized mutation so display name and sources commit together; see withReportedDescriptor’s omission exception.

type HostNameIdentity = Pick<
  StoredHostProfile,
  'name' | 'personalName' | 'lastKnownMachineName' | 'lastKnownHostPlatform'
>

export type ReportedHostDescriptor = {
  machineName: string | null
  platform: NodeJS.Platform | null
}

// Classify only legacy names with no identity fields; current records already preserve explicit overrides or generated names.
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

// Preserve stored identity during save because incoming pairing/connection snapshots may predate renames and descriptor reads.
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

// Readable status authoritatively clears omitted descriptor fields and updates unoverridden names.
// OS-only reports retain the adopted display name even when the last-known machine name clears.
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
