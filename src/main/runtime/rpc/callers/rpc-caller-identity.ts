/** Transport-proven identity, never request params, controls durable ledger namespaces and whose view a launch moves. */

import type { RpcDispatchStreamingOptions } from '../dispatch/dispatcher-stream-options'
import { CLI_AGENT_CALLER_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/cli-agent-caller-capability'

export type RpcCallerIdentity =
  /** The `orca` CLI over the runtime socket, and the in-process bridges that relay it. */
  | { kind: 'local-cli' }
  /** All local IPC windows share identity across reload and app restart. */
  | { kind: 'desktop' }
  /** A paired phone or remote desktop, by its device subject, which survives credential rotation.
   *  `agent`: the orca CLI calling with that device's pairing (`--environment`), not the person using it. */
  | { kind: 'paired-device'; deviceId: string; agent?: true }

export const DESKTOP_RPC_CALLER: RpcCallerIdentity = { kind: 'desktop' }
/** Stamped by the owner-token runtime socket, which only the local `orca` CLI holds. */
export const LOCAL_CLI_RPC_CALLER: RpcCallerIdentity = { kind: 'local-cli' }

/** The orca CLI agents run, on this host or over a device's pairing; people's windows and phones are not. */
export function isAgentRpcCaller(caller: RpcCallerIdentity | undefined): boolean {
  return caller?.kind === 'local-cli' || (caller?.kind === 'paired-device' && caller.agent === true)
}

/** Trust explicit transport identity; unnamed declared clients have none. Temporarily, no declared client means local CLI.
 * The runtime socket stamps local-cli explicitly; plugin approval never trusts identity alone (it needs the approve fingerprint). */
export function resolveRpcCallerIdentity(
  transport:
    | Pick<
        RpcDispatchStreamingOptions,
        'caller' | 'clientKind' | 'pairedDeviceId' | 'clientCapabilities'
      >
    | undefined
): RpcCallerIdentity | undefined {
  if (transport?.caller) {
    return transport.caller
  }
  const deviceId = transport?.pairedDeviceId?.trim()
  if (deviceId) {
    // A false claim only gives up the person's view-following, never any authority.
    return transport?.clientCapabilities?.includes(CLI_AGENT_CALLER_CLIENT_CAPABILITY)
      ? { kind: 'paired-device', deviceId, agent: true }
      : { kind: 'paired-device', deviceId }
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
