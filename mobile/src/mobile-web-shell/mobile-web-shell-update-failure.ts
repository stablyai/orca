import type { MobileWebBundleErrorCode } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  isMobileWebBundleTransportFailure,
  readMobileWebBundleErrorCode
} from '../transport/mobile-web-bundle-operations'
import type { MobileWebShellBlockedVerdict } from './mobile-web-shell-session-contract'
import {
  MOBILE_WEB_BUNDLE_FETCH_REFUSALS,
  MobileWebBundleFetchError
} from '../transport/mobile-web-bundle-fetch-refusal'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'

// Record closed codes only; error text can contain asset paths, hashes or transport endpoints.
export const MOBILE_WEB_SHELL_UPDATE_FAILURE_REASONS = [
  'no-connection',
  'connection-lost',
  'host-refused',
  'reply-unreadable',
  ...MOBILE_WEB_BUNDLE_FETCH_REFUSALS,
  // Bytes verified; local staging/commit failed.
  'cache-write-failed',
  'unrecognised-error'
] as const

export type MobileWebShellUpdateFailureReason =
  (typeof MOBILE_WEB_SHELL_UPDATE_FAILURE_REASONS)[number]

export type MobileWebShellUpdateFailureCause = {
  readonly reason: MobileWebShellUpdateFailureReason
  readonly hostCode: MobileWebBundleErrorCode | null
}

// Transport failure alone proves nothing about bundle validity.
export type MobileWebShellReadFailure = 'transport' | 'bundle'

export function readFailureSide(
  reason: MobileWebShellUpdateFailureReason
): MobileWebShellReadFailure {
  return reason === 'no-connection' || reason === 'connection-lost' ? 'transport' : 'bundle'
}

// Classify transport first: cutover errors may fit another category, but link loss controls fallback.
export function updateFailureCauseOf(error: unknown): MobileWebShellUpdateFailureCause {
  if (isMobileWebBundleTransportFailure(error)) {
    return { reason: 'connection-lost', hostCode: null }
  }
  const hostCode = readMobileWebBundleErrorCode(error)
  if (hostCode !== null) {
    return { reason: 'host-refused', hostCode }
  }
  if (error instanceof MobileWebBundleFetchError) {
    return { reason: error.refusal, hostCode: null }
  }
  if (error instanceof RpcIncompatibleReplyError) {
    return { reason: 'reply-unreadable', hostCode: null }
  }
  return { reason: 'unrecognised-error', hostCode: null }
}

export const MOBILE_WEB_SHELL_UPDATE_FAILURE_OUTCOMES = [
  'opened-cached',
  // Written by builds that still fell back to native screens; kept so their records still read.
  'native-route',
  'route-unavailable',
  'wall',
  'failed',
  'waiting'
] as const

export type MobileWebShellUpdateFailureOutcome =
  (typeof MOBILE_WEB_SHELL_UPDATE_FAILURE_OUTCOMES)[number]

// Persist wall codes only; keep version numbers on screen.
export const MOBILE_WEB_SHELL_UPDATE_FAILURE_WALLS = [
  'bundle-unavailable',
  'bundle-shell-too-old',
  'host-too-old-for-bundle',
  'bundle-too-old-for-host',
  'page-route-unlisted',
  'page-route-grant-missing'
] as const

export type MobileWebShellUpdateFailureWall = (typeof MOBILE_WEB_SHELL_UPDATE_FAILURE_WALLS)[number]

export function updateFailureWallOf(
  verdict: MobileWebShellBlockedVerdict
): MobileWebShellUpdateFailureWall {
  if (verdict.reason !== 'bundle-incompatible') {
    return verdict.reason
  }
  return verdict.side === 'desktop' ? 'host-too-old-for-bundle' : 'bundle-too-old-for-host'
}

// The runner adds host/time; build ids must be generation digests, never paths or URLs.
export type MobileWebShellUpdateFailureFacts = MobileWebShellUpdateFailureCause & {
  readonly offeredBuildId: string | null
  readonly cachedBuildId: string | null
  readonly outcome: MobileWebShellUpdateFailureOutcome
  readonly wall: MobileWebShellUpdateFailureWall | null
}

export type MobileWebShellUpdateFailure = MobileWebShellUpdateFailureFacts & {
  readonly hostId: string
  readonly at: number
}
