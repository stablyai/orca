import {
  BROWSER_CLIENT_PROFILE_SWITCH_CAPABILITY,
  BrowserClientProfileMetadata
} from '../../../shared/browser-client-profile-switch-protocol'

type BrowserHostClientProfileResolver = (browserProfileId: string) => unknown

let resolveProfile: BrowserHostClientProfileResolver | null = null

/** Installed by the host that owns browser profiles; without one, pages carry only profile ids. */
export function setBrowserHostClientProfileResolver(
  resolver: BrowserHostClientProfileResolver | null
): void {
  resolveProfile = resolver
}

/**
 * The host-owned profile a page command may carry to the desktop.
 *
 * Why: a desktop can only rebuild a page in a profile it was told about, so restores and
 * recoveries after a switch need the same metadata the switch sent. Its own default needs none.
 */
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
