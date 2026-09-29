import type { MobileWebBundleErrorCode } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  isMobileWebBundleTransportFailure,
  readMobileWebBundleErrorCode
} from '../transport/mobile-web-bundle-operations'
import type { MobileWebBundleCompatVerdict } from '../transport/mobile-web-bundle-compat'
import {
  MOBILE_WEB_BUNDLE_FETCH_REFUSALS,
  MobileWebBundleFetchError
} from '../transport/mobile-web-bundle-fetch-refusal'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'

/**
 * Why a read of the host's generation produced nothing, as a closed code.
 *
 * Codes only, never an error's message: the fetch's messages name asset paths and hashes, and a
 * transport error's can carry an endpoint. What this device records is what is listed here.
 */
export const MOBILE_WEB_SHELL_UPDATE_FAILURE_REASONS = [
  /** No client to ask: the link was already gone when the read was due. */
  'no-connection',
  'connection-lost',
  /** One of the host's own bundle codes, carried beside it as `hostCode`. */
  'host-refused',
  'reply-unreadable',
  ...MOBILE_WEB_BUNDLE_FETCH_REFUSALS,
  /** The bytes arrived whole and this phone could not stage or commit them. */
  'cache-write-failed',
  'unrecognised-error'
] as const

export type MobileWebShellUpdateFailureReason =
  (typeof MOBILE_WEB_SHELL_UPDATE_FAILURE_REASONS)[number]

export type MobileWebShellUpdateFailureCause = {
  readonly reason: MobileWebShellUpdateFailureReason
  /** Non-null only for `host-refused`. */
  readonly hostCode: MobileWebBundleErrorCode | null
}

/** Which side a failed read landed on: `transport` says nothing about the bundle. */
export type MobileWebShellReadFailure = 'transport' | 'bundle'

export function readFailureSide(
  reason: MobileWebShellUpdateFailureReason
): MobileWebShellReadFailure {
  return reason === 'no-connection' || reason === 'connection-lost' ? 'transport' : 'bundle'
}

/** The cause of a rejected manifest read or fetch. Transport first, because a cutover error can
 *  also be something else and the link going is the fact the reducer branches on. */
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

/** What the shell put on screen instead of the generation it could not take. */
export const MOBILE_WEB_SHELL_UPDATE_FAILURE_OUTCOMES = [
  'opened-cached',
  'native-route',
  'wall',
  'failed',
  'waiting'
] as const

export type MobileWebShellUpdateFailureOutcome =
  (typeof MOBILE_WEB_SHELL_UPDATE_FAILURE_OUTCOMES)[number]

/** The compat verdict behind a wall, flattened to one code: the version numbers stay on screen. */
export const MOBILE_WEB_SHELL_UPDATE_FAILURE_WALLS = [
  'bundle-unavailable',
  'bundle-shell-too-old',
  'host-too-old-for-bundle',
  'bundle-too-old-for-host'
] as const

export type MobileWebShellUpdateFailureWall = (typeof MOBILE_WEB_SHELL_UPDATE_FAILURE_WALLS)[number]

export function updateFailureWallOf(
  verdict: Extract<MobileWebBundleCompatVerdict, { kind: 'blocked' }>
): MobileWebShellUpdateFailureWall {
  if (verdict.reason !== 'bundle-incompatible') {
    return verdict.reason
  }
  return verdict.side === 'desktop' ? 'host-too-old-for-bundle' : 'bundle-too-old-for-host'
}

/** Everything the reducer knows about one failed update, which the runner stamps with a host and a
 *  time. Build ids are the generation digests, never a path or a URL. */
export type MobileWebShellUpdateFailureFacts = MobileWebShellUpdateFailureCause & {
  /** The generation the host offered this flow, or null when the manifest never arrived. */
  readonly offeredBuildId: string | null
  /** The generation already on disk when the read failed. */
  readonly cachedBuildId: string | null
  readonly outcome: MobileWebShellUpdateFailureOutcome
  readonly wall: MobileWebShellUpdateFailureWall | null
}

export type MobileWebShellUpdateFailure = MobileWebShellUpdateFailureFacts & {
  readonly hostId: string
  /** Epoch milliseconds. */
  readonly at: number
}
