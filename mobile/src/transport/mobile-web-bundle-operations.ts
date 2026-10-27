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

// Require whole results and settle immediately; salvaging would hide corruption, and deferred refusals would leave sibling reads running.

export const mobileWebBundleManifestRead = defineRpcOperation({
  name: 'mobileWeb.bundle-manifest',
  method: MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('mobile-web-bundle-manifest', MobileWebBundleManifestReplySchema)
})

export const mobileWebBundleChunkRead = defineRpcOperation({
  name: 'mobileWeb.bundle-chunk',
  method: MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('mobile-web-bundle-chunk', MobileWebBundleChunkReplySchema)
})

// Use ranges only when the manifest advertises their grid; host compression is optional.
export const mobileWebBundleRangeRead = defineRpcOperation({
  name: 'mobileWeb.bundle-range',
  method: MOBILE_WEB_BUNDLE_RANGE_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('mobile-web-bundle-range', MobileWebBundleRangeReplySchema)
})

/** A code is a bare snake_case token, so only the two positions one can occupy are read. */
const LEADING_CODE_TOKEN = /^[a-z][a-z0-9_]*/

// Read contract codes only as the whole message or after the envelope code; quoted prose must not become a machine verdict.
// Other errors, including transport failures, have no bundle code.
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

// Only transport marks establish link failure; hash/length/build refusals describe arrived bytes rather than connectivity.
export function isMobileWebBundleTransportFailure(error: unknown): boolean {
  return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
}
