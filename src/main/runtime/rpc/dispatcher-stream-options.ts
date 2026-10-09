import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { PairingRpcContext } from './core'
import type { RpcCallerIdentity } from './rpc-caller-identity'
import type { RpcCallerScope } from './rpc-caller-scope'

export type RpcDispatchStreamingOptions = {
  authenticatedCallerFingerprint?: string
  connectionId?: string
  signal?: AbortSignal
  clientId?: string
  pairedDeviceId?: string
  /** Set by a transport that knows its caller but carries no paired device (the desktop's IPC). */
  caller?: RpcCallerIdentity
  /** What the transport proved the caller may do; absent means this host's owner. */
  callerScope?: RpcCallerScope
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
  updateClientCapabilities?: (capabilities: readonly RuntimeCapability[]) => void
  pairing?: PairingRpcContext
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  registerBinaryStreamHandler?: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
  registerBinaryMessageHandler?: (
    handler: (bytes: Uint8Array<ArrayBufferLike>) => void
  ) => () => void
}
