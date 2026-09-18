import {
  MobileWebBundleErrorCodeSchema,
  MOBILE_WEB_BUNDLE_CHUNK_METHOD,
  MOBILE_WEB_BUNDLE_MANIFEST_METHOD,
  type MobileWebBundleErrorCode
} from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import {
  MobileWebBundleChunkReplySchema,
  MobileWebBundleManifestReplySchema
} from './mobile-web-bundle-reply-schemas'
import { defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'

// The two reads that hand a paired phone the desktop's mobile web bundle. Both are
// `require-result-or-throw`: there is no partial success here, and a salvage policy would produce a
// half-bundle that fails a hash check much later, far from the cause. Both settle at `on-settle`,
// because each reply is acted on before the next request is built — the manifest decides which
// assets to page, and a chunk decides the next offset.

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
