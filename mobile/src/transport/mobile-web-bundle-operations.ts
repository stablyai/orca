import {
  MobileWebBundleErrorCodeSchema,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  MOBILE_WEB_BUNDLE_RANGE_METHOD,
  type MobileWebBundleErrorCode
} from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  MobileWebBundleChunkReplySchema,
  MobileWebBundleManifestReplySchema,
  MobileWebBundleRangeReplySchema
} from './mobile-web-bundle-reply-schemas'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { defineRpcOperation } from './rpc-operation'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'
import { rpcResultVariant } from './rpc-operation-result-reader'

// The reads that hand a paired phone the desktop's mobile web bundle. All are
// `require-result-or-throw`: there is no partial success here, and a salvage policy would produce a
// half-bundle that fails a hash check much later, far from the cause. All settle at `on-settle`,
// because each reply is interpreted as soon as it lands and waits on no sibling: the manifest before
// any window is planned, and each chunk or range while the other reads are still in flight.

/** The whole manifest plus the chunk size the host will serve it at. */
export const mobileWebBundleManifestRead = defineRpcOperation({
  name: 'mobileWeb.bundle-manifest',
  method: MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('mobile-web-bundle-manifest', MobileWebBundleManifestReplySchema)
})

/** One page of one asset, self-describing so a misplaced reply cannot corrupt a reassembly. */
export const mobileWebBundleChunkRead = defineRpcOperation({
  name: 'mobileWeb.bundle-chunk',
  method: MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('mobile-web-bundle-chunk', MobileWebBundleChunkReplySchema)
})

/** One 384 KiB window of an asset, gzipped when that shrinks it. Only sent to a host whose manifest
 *  reply named `rangeBytes`. */
export const mobileWebBundleRangeRead = defineRpcOperation({
  name: 'mobileWeb.bundle-range',
  method: MOBILE_WEB_BUNDLE_RANGE_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('mobile-web-bundle-range', MobileWebBundleRangeReplySchema)
})

/** A code is a bare snake_case token, so only the two positions one can occupy are read. */
const LEADING_CODE_TOKEN = /^[a-z][a-z0-9_]*/

/**
 * The host's six codes, read back off a thrown refusal.
 *
 * The host raises these as `InvalidArgumentError`, which the dispatcher maps to envelope code
 * `invalid_argument` with the machine code as the message
 * (`src/main/runtime/rpc/dispatcher-error-response.ts`), and `require-result-or-throw` throws
 * `` `${code}: ${message}` ``. So the token this branches on is either the whole message or what
 * follows the envelope code, and nowhere else: scanning the prose for a code anywhere would let a
 * host that merely quoted one back read as that failure.
 *
 * Returns null for every other error, including a transport rejection, which is not a verdict about
 * the bundle at all. Membership is decided by the contract's own enum, so the arms cannot drift
 * from `MOBILE_WEB_BUNDLE_ERROR_CODES`.
 */
export function readMobileWebBundleErrorCode(error: unknown): MobileWebBundleErrorCode | null {
  if (!(error instanceof Error)) {
    return null
  }
  const head = LEADING_CODE_TOKEN.exec(error.message)?.[0]
  if (head === undefined) {
    return null
  }
  const direct = MobileWebBundleErrorCodeSchema.safeParse(head)
  if (direct.success) {
    return direct.data
  }
  const prefix = `${head}: `
  if (!error.message.startsWith(prefix)) {
    return null
  }
  const nested = LEADING_CODE_TOKEN.exec(error.message.slice(prefix.length))?.[0]
  if (nested === undefined) {
    return null
  }
  const parsed = MobileWebBundleErrorCodeSchema.safeParse(nested)
  return parsed.success ? parsed.data : null
}

/**
 * True when a bundle read failed on the link to the host rather than on the bundle it serves.
 *
 * Both marks come from the transport itself: delivery-unknown on every request a socket close, a
 * relay drop or a timeout cut off, and the cutover error on a connection migration. Nothing else
 * qualifies, on purpose — the fetch raises plain errors for a hash mismatch, a short asset and a
 * build that changed mid-fetch, and every one of those is a verdict about the bytes that arrived.
 * `readMobileWebBundleErrorCode` above reads the host's own refusals, which are verdicts too.
 */
export function isMobileWebBundleTransportFailure(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}
