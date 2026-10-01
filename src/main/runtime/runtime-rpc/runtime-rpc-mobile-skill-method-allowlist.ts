import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc-mobile-method-allowlist'

/** Methods the mobile skills surface adds beyond the shared mobile allowlist,
 *  which sits at the repo's file-size cap. */
export const MOBILE_SKILLS_RPC_METHOD_ALLOWLIST = new Set(['skills.discover'])

/** Whether a mobile-scoped device token may dispatch `method`. */
export function isMobileRpcMethodAllowed(method: string): boolean {
  return MOBILE_RPC_METHOD_ALLOWLIST.has(method) || MOBILE_SKILLS_RPC_METHOD_ALLOWLIST.has(method)
}
