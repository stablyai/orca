import type { z } from 'zod'
import type { RpcContext } from '../../core'
import type {
  TerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../../../shared/terminal-stream-protocol'
import type { TerminalOutputFrameChunk } from '../../terminal-output-frame-chunks'
import type {
  TerminalMultiplexSnapshotRequestFrame,
  TerminalMultiplexSubscribeFrame
} from './stream-schemas'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import type { TerminalSourceRangeRegistry } from '../../terminal-source-range-registry'

export type MultiplexSubscribeRequest = z.infer<typeof TerminalMultiplexSubscribeFrame>
export type MultiplexSnapshotRequest = z.infer<typeof TerminalMultiplexSnapshotRequestFrame>
export type MultiplexEmit = (result: unknown) => void

export type TerminalMultiplexConnectionBase = {
  runtime: RpcContext['runtime']
  connectionId: string
  sendBinary: NonNullable<RpcContext['sendBinary']>
  registerBinaryStreamHandler: NonNullable<RpcContext['registerBinaryStreamHandler']>
  signal: RpcContext['signal']
  emit: MultiplexEmit
  closed: boolean
  cursor: number
  streams: Map<number, TerminalMultiplexStream>
  sourceRangeRegistry: TerminalSourceRangeRegistry
  pendingPtyWaitControllers: Map<number, Set<AbortController>>
  ackTotalInFlightBytes: number
  ackTotalWindowBytes: number
  ackFlushCursorStreamId: number | null
  resolveMultiplex: () => void
  multiplexClosed: Promise<void>
  unregisterControlHandler: () => void
}

export type TerminalMultiplexFrameDelivery = {
  sendFrame: (
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload?: Uint8Array<ArrayBufferLike>,
    frameSeq?: number,
    onRejected?: () => void
  ) => boolean
  sendStreamError: (streamId: number, message: string) => void
  notifyStreamWriteUnavailable: (
    stream: TerminalMultiplexStream,
    outcome: 'delivered' | 'rejected' | 'failed'
  ) => void
  sendResizedFrame: (
    stream: TerminalMultiplexStream,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ) => void
  canSendAckGatedOutput: (stream: TerminalMultiplexStream, bytes: number) => boolean
  sendAckGatedOutput: (stream: TerminalMultiplexStream, chunk: TerminalOutputFrameChunk) => boolean
  queueOrSendOutput: (stream: TerminalMultiplexStream, chunk: TerminalOutputFrameChunk) => void
}

export type TerminalMultiplexFlowControl = {
  sendAckRecoverySnapshot: (stream: TerminalMultiplexStream) => Promise<void>
  flushAckPendingOutput: (stream: TerminalMultiplexStream, maxChunks?: number) => number
  flushAllAckPendingOutput: () => void
  acknowledgeOutput: (stream: TerminalMultiplexStream, bytes: number) => void
  acknowledgeSourceRanges: (
    stream: TerminalMultiplexStream,
    streamGeneration: string,
    ackedEndByte: number
  ) => void
  detachSourceRangeConsumer: (stream: TerminalMultiplexStream, reason: string) => void
}

export type TerminalMultiplexCleanup = {
  detachStream: (streamId: number, emitEnd: boolean, releaseRemoteDesktopDriver?: boolean) => void
  cancelPendingPtyWaits: (streamId: number) => void
  cancelAllPendingPtyWaits: () => void
  closeMultiplex: () => void
}

export type TerminalMultiplexSlotFrames = {
  handleSlotFrame: (stream: TerminalMultiplexStream, frame: TerminalStreamFrame) => void
  sendRequestedSnapshot: (
    stream: TerminalMultiplexStream,
    request: MultiplexSnapshotRequest
  ) => Promise<void>
}

export type TerminalMultiplexSubscribeFrame = {
  handleSubscribeFrame: (payload: Uint8Array<ArrayBufferLike>) => Promise<void>
}

export type TerminalMultiplexFrameDeliveryStage = TerminalMultiplexConnectionBase &
  TerminalMultiplexFrameDelivery

export type TerminalMultiplexFlowControlStage = TerminalMultiplexFrameDeliveryStage &
  TerminalMultiplexFlowControl

export type TerminalMultiplexCleanupStage = TerminalMultiplexFlowControlStage &
  TerminalMultiplexCleanup

export type TerminalMultiplexSlotFramesStage = TerminalMultiplexCleanupStage &
  TerminalMultiplexSlotFrames

export type TerminalMultiplexConnection = TerminalMultiplexSlotFramesStage &
  TerminalMultiplexSubscribeFrame
