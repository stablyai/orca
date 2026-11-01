/** Transport-proven identity, never request params, controls durable ledger namespaces and whose view a launch moves. */

import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'

export type RpcCallerIdentity =
  /** The `orca` CLI over the runtime socket, and the in-process bridges that relay it. */
  | { kind: 'local-cli' }
  /** All local IPC windows share identity across reload and app restart. */
  | { kind: 'desktop' }
  /** A paired phone or remote desktop, by its device subject, which survives credential rotation. */
  | { kind: 'paired-device'; deviceId: string }

export const DESKTOP_RPC_CALLER: RpcCallerIdentity = { kind: 'desktop' }
/** Stamped by the owner-token runtime socket, which only the local `orca` CLI holds. */
export const LOCAL_CLI_RPC_CALLER: RpcCallerIdentity = { kind: 'local-cli' }

/** The orca CLI agents run, locally or forwarded from a remote host; relayed devices are people. */
export function isAgentRpcCaller(caller: RpcCallerIdentity | undefined): boolean {
  return caller?.kind === 'local-cli'
}

/** Trust explicit transport identity; unnamed declared clients have none. Temporarily, no declared client means local CLI.
 * The runtime socket stamps local-cli explicitly; plugin approval never trusts identity alone (it needs the approve fingerprint). */
export function resolveRpcCallerIdentity(
  transport:
    | Pick<RpcDispatchStreamingOptions, 'caller' | 'clientKind' | 'pairedDeviceId'>
    | undefined
): RpcCallerIdentity | undefined {
  if (transport?.caller) {
    return transport.caller
  }
  const deviceId = transport?.pairedDeviceId?.trim()
  if (deviceId) {
    return { kind: 'paired-device', deviceId }
  }
  return transport?.clientKind === undefined ? { kind: 'local-cli' } : undefined
}

/** Permanent durable-ledger keys: existing CLI and device rows must remain addressable across versions. */
export function rpcCallerOperationKey(caller: RpcCallerIdentity): string {
  switch (caller.kind) {
    case 'local-cli':
      return 'trusted-local:runtime'
    case 'desktop':
      return 'trusted-local:desktop'
    case 'paired-device':
      return caller.deviceId
  }
}
