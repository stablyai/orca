/**
 * Which permissions each kind of caller holds, checked once by the dispatcher for every transport.
 *
 * A transport stamps the scope it proved (device token, SSH bridge credential); an unstamped call is
 * this host's own desktop or owner-token CLI. Every non-owner row is deny-by-default: a method is
 * reachable only when its declared permission is in the row.
 */
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import type { RpcMethodPermission, RuntimeDeviceGrant } from './rpc-method-permission'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  bindSshBridgeCall,
  SSH_BRIDGE_HOST_BINDERS,
  SSH_BRIDGE_REMOTE_CONTROL_HINT,
  type SshBridgeCallBinding
} from './ssh-bridge-host-binding'

export type { RuntimeDeviceGrant }

export type RpcCallerScope =
  | { kind: 'owner' }
  | { kind: 'mobile' }
  | { kind: 'runtime-paired'; grants: readonly RuntimeDeviceGrant[] }
  /** The `orca` CLI of a remote SSH host, relayed through this host's bridge. `remoteCliControl`
   *  is the per-target opt-in that lets that host's CLI act outside its own terminals. */
  | { kind: 'ssh-bridge'; targetId: string; remoteCliControl: boolean }

export const OWNER_RPC_CALLER_SCOPE: RpcCallerScope = { kind: 'owner' }

// Why: a paired desktop, web client or `--host runtime:` CLI is this runtime's full remote UI, so its
// standard set covers what that UI drives here (settings, accounts, skills, SSH and server updates).
// Everything else (desktop control, pairing and push admin) is refused unless granted at pairing.
const RUNTIME_PAIRED_STANDARD: ReadonlySet<RpcMethodPermission> = new Set([
  'workspace',
  'settings-write',
  'accounts-admin',
  'skills-admin',
  'host-admin'
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
    return MOBILE_RPC_METHOD_ALLOWLIST.has(methodName)
      ? null
      : `Method '${methodName}' is not available to mobile clients`
  }
  if (scope.kind === 'owner' || permission === undefined) {
    return null
  }
  if (scope.kind === 'runtime-paired') {
    return !RUNTIME_PAIRED_STANDARD.has(permission) &&
      !scope.grants.some((grant) => grant === permission)
      ? `Method '${methodName}' needs the '${permission}' permission, which this paired client was not granted when it paired.`
      : null
  }
  if (scope.remoteCliControl) {
    return permission === 'workspace'
      ? null
      : `Method '${methodName}' is not available to an SSH host's orca CLI.`
  }
  return permission === 'workspace' && SSH_BRIDGE_HOST_BINDERS.has(methodName)
    ? null
    : `Method '${methodName}' is not available to the orca CLI on SSH host '${scope.targetId}'. ${SSH_BRIDGE_REMOTE_CONTROL_HINT}`
}

/**
 * Binds an allowed call's selectors to the caller's host; only the unopted SSH bridge is bound.
 * Null (not a resolved promise) when unbound, so other callers' dispatch gains no extra tick.
 */
export function bindRpcCallToCallerScope(
  scope: RpcCallerScope,
  runtime: OrcaRuntimeService,
  methodName: string,
  params: unknown
): Promise<SshBridgeCallBinding> | null {
  if (scope.kind !== 'ssh-bridge' || scope.remoteCliControl) {
    return null
  }
  return bindSshBridgeCall(runtime, scope.targetId, methodName, params)
}
