/**
 * Which permissions each kind of caller holds, checked once by the dispatcher for every transport.
 *
 * A transport stamps the scope it proved (device token); an unstamped call is
 * this host's own desktop or owner-token CLI. Every non-owner row is deny-by-default: a method is
 * reachable only when its declared permission is in the row.
 */
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import type { RpcMethodPermission, RuntimeDeviceGrant } from './rpc-method-permission'

export type { RuntimeDeviceGrant }

export type RpcCallerScope =
  | { kind: 'owner' }
  /** `delegated`: a phone a paired desktop holds a child device for; it reaches no further than that
   *  desktop, which is never granted `pairing-admin`. */
  | { kind: 'mobile'; delegated?: boolean }
  | { kind: 'runtime-paired'; grants: readonly RuntimeDeviceGrant[] }

export const OWNER_RPC_CALLER_SCOPE: RpcCallerScope = { kind: 'owner' }

// Why: a paired desktop, web client or `--host runtime:` CLI is this runtime's full remote UI, so its
// standard set covers what that UI drives here (settings, accounts, skills, SSH and server updates).
// None of these exceeds `workspace`, which already runs commands as the user (see
// rpc-method-permission.ts). Desktop control needs a grant at pairing; pairing admin is never
// granted to this row.
const RUNTIME_PAIRED_STANDARD: ReadonlySet<RpcMethodPermission> = new Set([
  'workspace',
  'settings-write',
  'accounts-admin',
  'skills-admin',
  'host-admin',
  'device-self'
])

/**
 * Returns the refusal message, or null when the caller may invoke the method. `permission` is
 * undefined for a method this build does not register; only the mobile row answers that by name,
 * because phones read `forbidden` (not `method_not_found`) as "this desktop predates the method".
 */
export function denyRpcMethodForCaller(
  scope: RpcCallerScope,
  methodName: string,
  permission: RpcMethodPermission | undefined
): string | null {
  if (scope.kind === 'mobile') {
    if (!MOBILE_RPC_METHOD_ALLOWLIST.has(methodName)) {
      return `Method '${methodName}' is not available to mobile clients`
    }
    return scope.delegated && permission === 'pairing-admin'
      ? `Method '${methodName}' is not available to a phone connected through a paired desktop`
      : null
  }
  if (scope.kind === 'owner' || permission === undefined) {
    return null
  }
  return !RUNTIME_PAIRED_STANDARD.has(permission) &&
    !scope.grants.some((grant) => grant === permission)
    ? `Method '${methodName}' needs the '${permission}' permission, which this paired client was not granted when it paired.`
    : null
}
