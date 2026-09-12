import type { z } from 'zod'
import type { RpcContext } from '../../core'
import type { SubscriptionRegistration } from '../../../orca-runtime'
import type { TerminalReplyQuerySequence } from '../../../../../shared/terminal-reply-query-scan'
import type { TerminalOutputChunk } from './terminal-stream-types'
import type { TerminalSubscribe } from './stream-schemas'
import type { TerminalOutputBatcher } from './terminal-output-batcher'
import type { TerminalStreamOpcode } from '../../../../../shared/terminal-stream-protocol'

export type TerminalSubscribeParams = z.infer<typeof TerminalSubscribe>
export type TerminalSubscriptionEmit = (result: unknown) => void

export type TerminalSubscriptionArgs = {
  params: TerminalSubscribeParams
  runtime: RpcContext['runtime']
  connectionId: RpcContext['connectionId']
  sendBinary: RpcContext['sendBinary']
  registerBinaryStreamHandler: RpcContext['registerBinaryStreamHandler']
  signal: RpcContext['signal']
  emit: TerminalSubscriptionEmit
  ptyId: string
  clientId: string | undefined
  isMobile: boolean
  supportsDesktopViewportClaims: boolean
  supportsWriteUnavailable: boolean
  missingHeadlessStateBeforeMobileFit: boolean
  rendererMountRequestedBeforePty: boolean
  serializerGenerationBeforeMobileFit: number
}

export type LegacyBinarySubscriptionState = {
  readonly streamId: number
  readonly remoteDesktopSubscriptionKey: string
  closed: boolean
  buffering: boolean
  pendingRemoteDesktopViewport: { cols: number; rows: number } | null
  lastResizeCols: number | undefined
  resizeGeneration: number
  pendingOutput: TerminalOutputChunk[]
  pendingOutputBytes: number
  pendingOutputOverflowed: boolean
  readonly pendingQuerySequences: TerminalReplyQuerySequence[]
  pendingQueryOverflowed: boolean
  lateRendererReadyPromise: Promise<boolean> | null
  abortRendererMountWait: () => void
  outputBatcher: TerminalOutputBatcher
  unsubscribeResize: () => void
  unsubscribeFit: () => void
  registeredRemoteDesktopDriver: boolean
  displayMode: string
  readonly registration: SubscriptionRegistration
  readonly streamClosed: Promise<void>
  readonly sendFrame: (
    opcode: TerminalStreamOpcode,
    payload?: Uint8Array<ArrayBufferLike>,
    frameSeq?: number
  ) => void
}
