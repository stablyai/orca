import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'

/** The manifest schemas this app shell can mount. Widening it is a shell release, so the list is
 *  stated here rather than read off the contract's current version: the contract names the schema
 *  the desktop writes, which is exactly the number this shell may not recognise. */
export const SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS = [1] as const

/** Only the two `status.get` fields `host-status-gates.ts` already feeds `evaluateCompat`. */
export type MobileWebBundleHostStatus = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

/** The manifest fields the wall reads. Null means no manifest has been read yet, which is still
 *  enough to answer the capability question. */
export type MobileWebBundleCompatManifest = {
  schemaVersion: number
  runtimeProtocolVersion: number
  minCompatibleRuntimeProtocolVersion: number
}

export type MobileWebBundleCompatVerdict =
  | { kind: 'ok' }
  /** This desktop build ships no bundle at all. */
  | { kind: 'blocked'; reason: 'bundle-unavailable' }
  /** The bundle is written in a manifest schema this shell does not know. */
  | {
      kind: 'blocked'
      reason: 'bundle-shell-too-old'
      schemaVersion: number
      supportedSchemaVersions: readonly number[]
    }
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
 * Same `?? 0` defaults as `evaluateCompat`: a host that omits either field is treated as the
 * oldest one that could have answered, so an absent field never reads as permission.
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
    return { kind: 'ok' }
  }
  if (!knowsSchemaVersion(manifest.schemaVersion)) {
    return {
      kind: 'blocked',
      reason: 'bundle-shell-too-old',
      schemaVersion: manifest.schemaVersion,
      supportedSchemaVersions: SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS
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
  return { kind: 'ok' }
}
