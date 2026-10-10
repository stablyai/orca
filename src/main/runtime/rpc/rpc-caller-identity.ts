/**
 * Who is calling, as the host's own transport established it.
 *
 * One identity per caller, stamped by the dispatcher from what the connection proved — the runtime
 * socket, the desktop's IPC channel, or a paired device's authenticated socket — and never read
 * from request params, so a caller cannot claim to be another. Durable per-caller state (the launch
 * ledger's namespace) and per-caller behaviour (whose view a launch moves) both read this.
 */

import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'

export type RpcCallerIdentity =
  /** The `orca` CLI over the runtime socket, an owner's local stream on that socket, and the
   *  in-process bridges that relay it. */
  | { kind: 'local-cli' }
  /** This host's own desktop app over IPC. One identity for every window, so a reload or an app
   *  restart still names the same caller. */
  | { kind: 'desktop' }
  /** A paired phone or remote desktop, by its device subject, which survives credential rotation. */
  | { kind: 'paired-device'; deviceId: string }

export const DESKTOP_RPC_CALLER: RpcCallerIdentity = { kind: 'desktop' }
export const LOCAL_CLI_RPC_CALLER: RpcCallerIdentity = { kind: 'local-cli' }

/**
 * A transport that names its caller is believed; one that declares no client at all is the
 * in-process runtime socket, trusted as it always was; one that declares a client it cannot name has
 * no identity, and anything that needs one refuses it.
 *
 * Temporary: "no declared client" means the local CLI, so the SSH remote CLI bridge and browser
 * automation share its namespace, and a new transport that forgets to stamp its caller inherits it.
 * Before plugins ship (plan §4) the runtime socket stamps `local-cli` itself and no stamp means no
 * identity.
 */
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

/**
 * The caller's namespace in the durable operation ledger. Rows outlive the process, so these strings
 * are permanent: the CLI and paired-device keys are the ones rows were written under before this
 * identity existed.
 */
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
