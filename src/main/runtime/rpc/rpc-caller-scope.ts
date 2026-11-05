/** Transport stamps proven scope; unstamped calls are local desktop/owner CLI. Non-owner methods require an explicitly granted permission. */
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import type { RpcMethodPermission, RuntimeDeviceGrant } from './rpc-method-permission'

export type { RuntimeDeviceGrant }

export type RpcCallerScope =
  | { kind: 'owner' }
  /** Delegated phones inherit at most their paired desktop's scope, which never includes pairing-admin. */
  | { kind: 'mobile'; delegated?: boolean }
  | { kind: 'runtime-paired'; grants: readonly RuntimeDeviceGrant[] }

export const OWNER_RPC_CALLER_SCOPE: RpcCallerScope = { kind: 'owner' }

// Remote UI needs settings/accounts/skills/SSH/updates; workspace already runs host-user commands (rpc-method-permission.ts).
// Desktop control requires pairing-time grant; pairing admin is never granted.
const RUNTIME_PAIRED_STANDARD: ReadonlySet<RpcMethodPermission> = new Set([
  'workspace',
  'settings-write',
  'accounts-admin',
  'skills-admin',
  'host-admin',
  'device-self'
])

/** Mobile checks unknown methods by name because older phones interpret forbidden as unsupported; other callers retain method_not_found. */
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
