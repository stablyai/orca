import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { PairingRpcContext } from './core'
import type { RuntimeTargetBinding } from './runtime-target-binding'

export type RpcDispatchStreamingOptions = {
  authenticatedCallerFingerprint?: string
  /** How the request reached this runtime; decides what target binding it must carry. */
  transport?: RuntimeTargetBinding
  connectionId?: string
  signal?: AbortSignal
  clientId?: string
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
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

/** Non-streaming dispatch options. Shares `transport` with the streaming shape:
 *  the target-binding requirement is a property of the connection, not of the
 *  reply style. */
export type RpcDispatchOptions = {
  signal?: AbortSignal
  authenticatedCallerFingerprint?: string
  transport?: RuntimeTargetBinding
}
