import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import type { HostStatusReply } from './host-status-reply-schema'

// Keep this shell’s page floor explicit; older pages require updating the desktop.
export const MOBILE_WEB_PAGE_VERSION_FLOOR = 1

// Widen supported schemas only with a shell release; the writer’s current schema may be newer than this shell.
export const SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS = [1] as const

// Reuse reply fields so renames fail typechecking; missing host protocol means oldest, while a missing mobile floor means none.
export type MobileWebBundleHostStatus = Pick<
  HostStatusReply,
  'protocolVersion' | 'minCompatibleMobileVersion'
>

// A missing manifest still permits answering the host capability question.
export type MobileWebBundleCompatManifest = {
  schemaVersion: number
  runtimeProtocolVersion: number
  minCompatibleRuntimeProtocolVersion: number
  /** Absent from a desktop older than the field, which reads as 0: below every floor. */
  pageVersion?: number
}

export type MobileWebBundleCompatVerdict =
  // Before a manifest is checked, ok permits fetching it, not opening it.
  | { kind: 'ok'; manifestChecked: boolean }
  | { kind: 'blocked'; reason: 'bundle-unavailable' }
  | { kind: 'blocked'; reason: 'bundle-shell-too-old'; schemaVersion: number }
  | {
      kind: 'blocked'
      reason: 'bundle-incompatible'
      side: 'desktop'
      hostProtocolVersion: number
      requiredHostProtocolVersion: number
    }
  | {
      kind: 'blocked'
      reason: 'bundle-incompatible'
      side: 'desktop'
      pageVersion: number
      requiredPageVersion: number
    }
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

// Evaluate capability before manifest, then schema before protocol fields it may make unreadable.
// Missing host protocol fails the bundle floor; a missing declared mobile floor invents no restriction.
// Compatibility walls require updating an app rather than falling back to native workspaces.
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
  const pageVersion = manifest.pageVersion ?? 0
  if (pageVersion < MOBILE_WEB_PAGE_VERSION_FLOOR) {
    return {
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'desktop',
      pageVersion,
      requiredPageVersion: MOBILE_WEB_PAGE_VERSION_FLOOR
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
