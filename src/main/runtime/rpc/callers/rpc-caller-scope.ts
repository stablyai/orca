/** Transport stamps proven scope; unstamped calls are local desktop/owner CLI. Non-owner methods require an explicitly granted permission. */
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../server/runtime-rpc-mobile-method-allowlist'
import { teammateMethodClass } from '../../../bots/team-share/teammate-rules'
import type { RpcMethodPermission, RuntimeDeviceGrant } from './rpc-method-permission'
import type { RpcMethodShare } from '../../../../shared/bots/bot-share-rpc-methods'

export type RpcCallerScope =
  | { kind: 'owner' }
  /** Delegated phones inherit at most their paired desktop's scope, which never includes pairing-admin. */
  | { kind: 'mobile'; delegated?: boolean }
  | {
      kind: 'runtime-paired'
      grants: readonly RuntimeDeviceGrant[]
      /** Test-only: a desktop paired over Relay keeps its own Relay credential, as a phone does. */
      relayCredentialSelf?: true
    }
  /** A teammate the owner shared one bot with, by the share row their device key signed in as. */
  | BotShareCallerScope

export type BotShareCallerScope = {
  kind: 'bot-share'
  botId: string
  accountId: string
  /** Their Orca works in the agent's workspaces (`bots.share-workspaces.v1`): every method as
   *  teammate-method-classes.json classifies it, each list kept to the agent's workspaces. */
  workspaceTier?: true
}

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

// A Relay client's calls for its own Relay credential (installed and renewed through this host).
const RELAY_CREDENTIAL_SELF_METHODS: ReadonlySet<string> = new Set([
  'pairing.getEndpoints',
  'pairing.provisionRelay'
])

/** Mobile checks unknown methods by name because older phones interpret forbidden as unsupported; other callers retain method_not_found. */
export function denyRpcMethodForCaller(
  scope: RpcCallerScope,
  methodName: string,
  permission: RpcMethodPermission | undefined,
  share: RpcMethodShare | undefined
): string | null {
  if (scope.kind === 'mobile') {
    if (!MOBILE_RPC_METHOD_ALLOWLIST.has(methodName)) {
      return `Method '${methodName}' is not available to mobile clients`
    }
    return scope.delegated && permission === 'pairing-admin'
      ? `Method '${methodName}' is not available to a phone connected through a paired desktop`
      : null
  }
  if (scope.kind === 'bot-share') {
    // The workspace tier admits by its one table; a chats-only teammate by each method's share rule.
    const allowed = scope.workspaceTier
      ? teammateMethodClass(methodName) !== 'refused'
      : share !== undefined && share !== 'not-shared'
    return allowed ? null : `Method '${methodName}' is not available to a shared agent's teammates`
  }
  if (scope.kind === 'owner' || permission === undefined) {
    return null
  }
  if (scope.relayCredentialSelf && RELAY_CREDENTIAL_SELF_METHODS.has(methodName)) {
    return null
  }
  return !RUNTIME_PAIRED_STANDARD.has(permission) &&
    !scope.grants.some((grant) => grant === permission)
    ? `Method '${methodName}' needs the '${permission}' permission, which this paired client was not granted when it paired.`
    : null
}
