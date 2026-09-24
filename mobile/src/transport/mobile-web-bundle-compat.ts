import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { HostStatusReply } from './host-status-reply-schema'

/** The manifest schemas this app shell can mount. Widening it is a shell release, so the list is
 *  stated here rather than read off the contract's current version: the contract names the schema
 *  the desktop writes, which is exactly the number this shell may not recognise. */
export const SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS = [1] as const

/** Only the two `status.get` fields `host-status-gates.ts` already feeds `evaluateCompat`, taken
 *  from the reply type rather than restated: an upstream rename would otherwise leave a hand-copied
 *  shape behind and silently change every verdict through `?? 0` without failing a build. The two
 *  defaults point opposite ways, which is `evaluateCompat`'s own choice, not an accident here: an
 *  absent `protocolVersion` reads as the oldest host that could have answered, while an absent
 *  `minCompatibleMobileVersion` reads as no floor at all, so a host that states no floor does not
 *  get one invented for it. */
export type MobileWebBundleHostStatus = Pick<
  HostStatusReply,
  'protocolVersion' | 'minCompatibleMobileVersion'
>

/** The manifest fields the wall reads. Null means no manifest has been read yet, which is still
 *  enough to answer the capability question. */
export type MobileWebBundleCompatManifest = {
  schemaVersion: number
  runtimeProtocolVersion: number
  minCompatibleRuntimeProtocolVersion: number
}

export type MobileWebBundleCompatVerdict =
  /** `manifestChecked` false means only the capability was answered; no manifest had been read
   *  yet, so this is permission to fetch one, not permission to open it. */
  | { kind: 'ok'; manifestChecked: boolean }
  /** This desktop build ships no bundle at all. */
  | { kind: 'blocked'; reason: 'bundle-unavailable' }
  /** The bundle is written in a manifest schema this shell does not know. */
  | { kind: 'blocked'; reason: 'bundle-shell-too-old'; schemaVersion: number }
  /** The host is older than the bundle it is serving. */
  | {
      kind: 'blocked'
      reason: 'bundle-incompatible'
      side: 'desktop'
      hostProtocolVersion: number
      requiredHostProtocolVersion: number
    }
  /** The bundle is older than the host expects; the caller refetches. */
  | {
      kind: 'blocked'
      reason: 'bundle-incompatible'
      side: 'mobile'
      bundleRuntimeProtocolVersion: number
      requiredBundleRuntimeProtocolVersion: number
    }

function knowsSchemaVersion(schemaVersion: number): boolean {
  return SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS.some(
    (supported) => supported === schemaVersion
  )
}

/**
 * Whether a mobile web bundle may be opened against the host that served it.
 *
 * Pure and terminal: every blocked verdict is a wall the user leaves by updating one of the two
 * apps, never by falling back to a native workspace. Order matters — the capability answer comes
 * first because a host without a bundle has no manifest to disagree about, and the schema answer
 * comes before the protocol window because an unknown schema makes the numbers in it unreadable.
 *
 * Same `?? 0` defaults as `evaluateCompat`, and they are not symmetric. An absent
 * `protocolVersion` is the oldest host that could have answered, so it never reads as permission.
 * An absent `minCompatibleMobileVersion` is fail-open by design: a host that declares no floor for
 * the bundle it serves does not get one guessed at, and the desktop-side check above is what still
 * catches a host too old for that bundle.
 */
export function evaluateMobileWebBundleCompat(input: {
  hostCapabilities: readonly string[]
  hostStatus: MobileWebBundleHostStatus
  manifest: MobileWebBundleCompatManifest | null
}): MobileWebBundleCompatVerdict {
  if (!input.hostCapabilities.includes(MOBILE_WEB_BUNDLE_CAPABILITY)) {
    return { kind: 'blocked', reason: 'bundle-unavailable' }
  }
  const { manifest } = input
  if (manifest === null) {
    return { kind: 'ok', manifestChecked: false }
  }
  if (!knowsSchemaVersion(manifest.schemaVersion)) {
    return {
      kind: 'blocked',
      reason: 'bundle-shell-too-old',
      schemaVersion: manifest.schemaVersion
    }
  }
  const hostProtocolVersion = input.hostStatus.protocolVersion ?? 0
  if (hostProtocolVersion < manifest.minCompatibleRuntimeProtocolVersion) {
    return {
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'desktop',
      hostProtocolVersion,
      requiredHostProtocolVersion: manifest.minCompatibleRuntimeProtocolVersion
    }
  }
  const requiredBundleRuntimeProtocolVersion = input.hostStatus.minCompatibleMobileVersion ?? 0
  if (manifest.runtimeProtocolVersion < requiredBundleRuntimeProtocolVersion) {
    return {
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'mobile',
      bundleRuntimeProtocolVersion: manifest.runtimeProtocolVersion,
      requiredBundleRuntimeProtocolVersion
    }
  }
  return { kind: 'ok', manifestChecked: true }
}
