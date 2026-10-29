import {
  BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY,
  BrowserClientProfileMetadata
} from '../../../shared/browser-client-profile-switch-protocol'

type BrowserHostClientProfileResolver = (browserProfileId: string) => unknown

let resolveProfile: BrowserHostClientProfileResolver | null = null

export function setBrowserHostClientProfileResolver(
  resolver: BrowserHostClientProfileResolver | null
): void {
  resolveProfile = resolver
}

/** Restore/recovery must carry the same host-owned profile metadata as a switch; the desktop default needs none. */
export function browserHostClientProfileFor(
  lease: { hostCapabilities: readonly string[] },
  browserProfileId: string
): { profile?: BrowserClientProfileMetadata } {
  if (
    browserProfileId === 'default' ||
    !lease.hostCapabilities.includes(BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY)
  ) {
    return {}
  }
  const parsed = BrowserClientProfileMetadata.safeParse(resolveProfile?.(browserProfileId))
  return parsed.success && parsed.data.id === browserProfileId ? { profile: parsed.data } : {}
}
