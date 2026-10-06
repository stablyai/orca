import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { PairingRpcContext } from './core'

export type RpcDispatchStreamingOptions = {
  authenticatedCallerFingerprint?: string
  connectionId?: string
  signal?: AbortSignal
  /** Set by transports that drop the connection on an oversized frame; the dispatcher fails the
   *  one request instead. Unset means uncapped (desktop IPC, in-process callers). */
  replyFitsTransport?: (response: string) => boolean
  clientId?: string
  pairedDeviceId?: string
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
