import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES,
  canSendMobileWebTerminalOutput,
  type MobileWebTerminalEvent
} from '../../../src/shared/mobile-web/terminal-stream-contract'
import {
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '../transport/terminal-stream-protocol'
import type { RpcClient } from '../transport/rpc-client'
import {
  appendHostSnapshotChunk,
  decodeHostOutput,
  finishHostSnapshot,
  startHostSnapshot,
  type HostSnapshot
} from './mobile-web-terminal-frame-codec'
import type {
  MobileWebTerminalFlowMetrics,
  MobileWebTerminalResyncReason
} from './mobile-web-diagnostics-store'

type PendingOutput = { bytes: Uint8Array; hostBytes: number }
type AckSpan = { throughSequence: number; hostBytes: number; sentAtMs: number }

export type MobileWebTerminalStreamRecord = {
  requestId: string
  subscriptionId: string
  pageWorkspaceId: string
  hostWorkspaceId: string
  pageStreamId: string
  hostStreamId: number
  terminal: string
  viewport: { cols: number; rows: number }
  visible: boolean
  hostReady: boolean
  supportsQueryReply: boolean
  bridgeSequence: number
  sentSequence: number
  acknowledgedSequence: number
  nextInputSequence: number
  snapshotCounter: number
  snapshot: HostSnapshot | null
  pendingOutput: PendingOutput[]
  pendingOutputBytes: number
  ackSpans: AckSpan[]
  delivery: Promise<void>
  inputDelivery: Promise<void>
  client: RpcClient
}

type FlowContext = {
  post: (record: MobileWebTerminalStreamRecord, event: MobileWebTerminalEvent) => void
  sendAckBytes: (record: MobileWebTerminalStreamRecord, bytes: number) => void
  now: () => number
  recordFlow: (metrics: MobileWebTerminalFlowMetrics) => void
  requestSnapshot: (
    record: MobileWebTerminalStreamRecord,
    reason: MobileWebTerminalResyncReason
  ) => void
}

export function handleMobileWebHostTerminalFrame(
  record: MobileWebTerminalStreamRecord,
  frame: TerminalStreamFrame,
  context: FlowContext
): void {
  if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
    record.snapshot = startHostSnapshot(frame)
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
    if (!record.snapshot || !appendHostSnapshotChunk(record.snapshot, frame.payload)) {
      context.requestSnapshot(record, 'snapshot-invalid')
    }
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
    finishSnapshot(record, context)
    return
  }
  if (
    frame.opcode === TerminalStreamOpcode.Output ||
    frame.opcode === TerminalStreamOpcode.OutputSpan
  ) {
    queueOutput(record, frame, context)
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Error) {
    context.post(record, {
      type: 'error',
      streamId: record.pageStreamId,
      code: 'host_error',
      recoverable: true
    })
  }
}

export function acknowledgeMobileWebTerminalOutput(
  record: MobileWebTerminalStreamRecord,
  throughSequence: number,
  context: FlowContext
): boolean {
  if (throughSequence < record.acknowledgedSequence || throughSequence > record.sentSequence) {
    return false
  }
  record.acknowledgedSequence = throughSequence
  const acknowledgedAtMs = context.now()
  let hostBytes = 0
  let ackLagMs: number | undefined
  while (record.ackSpans.length > 0 && record.ackSpans[0]!.throughSequence <= throughSequence) {
    const span = record.ackSpans.shift()!
    hostBytes += span.hostBytes
    const spanLagMs = Math.max(0, acknowledgedAtMs - span.sentAtMs)
    ackLagMs = Math.max(ackLagMs ?? 0, spanLagMs)
  }
  context.sendAckBytes(record, hostBytes)
  flushOutput(record, context)
  context.recordFlow({
    ackLagMs,
    outstandingBytes: record.sentSequence - record.acknowledgedSequence
  })
  return true
}

export function supersedeMobileWebTerminalOutput(
  record: MobileWebTerminalStreamRecord,
  context: FlowContext
): void {
  const hostBytes =
    record.ackSpans.reduce((total, span) => total + span.hostBytes, 0) +
    record.pendingOutput.reduce((total, output) => total + output.hostBytes, 0)
  record.ackSpans = []
  record.pendingOutput = []
  record.pendingOutputBytes = 0
  record.acknowledgedSequence = record.sentSequence
  context.sendAckBytes(record, hostBytes)
}

function finishSnapshot(record: MobileWebTerminalStreamRecord, context: FlowContext): void {
  const snapshot = record.snapshot
  record.snapshot = null
  if (!snapshot) {
    return
  }
  supersedeMobileWebTerminalOutput(record, context)
  for (const event of finishHostSnapshot(
    snapshot,
    record.pageStreamId,
    snapshotIdentifier(record),
    record.sentSequence
  )) {
    context.post(record, event)
  }
}

function queueOutput(
  record: MobileWebTerminalStreamRecord,
  frame: TerminalStreamFrame,
  context: FlowContext
): void {
  const chunks = decodeHostOutput(frame)
  if (!chunks || chunks.length === 0) {
    context.sendAckBytes(record, frame.payload.byteLength)
    return
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const bytes = chunks[index]!
    record.pendingOutput.push({
      bytes,
      hostBytes: index === chunks.length - 1 ? frame.payload.byteLength : 0
    })
    record.pendingOutputBytes += bytes.byteLength
  }
  if (record.pendingOutputBytes > MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES) {
    supersedeMobileWebTerminalOutput(record, context)
    context.requestSnapshot(record, 'flow-overflow')
    return
  }
  flushOutput(record, context)
  context.recordFlow({
    ackLagMs: undefined,
    outstandingBytes: record.sentSequence - record.acknowledgedSequence
  })
}

function flushOutput(record: MobileWebTerminalStreamRecord, context: FlowContext): void {
  while (record.pendingOutput.length > 0) {
    const next = record.pendingOutput[0]!
    if (
      !canSendMobileWebTerminalOutput(
        record.acknowledgedSequence,
        record.sentSequence,
        next.bytes.byteLength
      )
    ) {
      return
    }
    record.pendingOutput.shift()
    record.pendingOutputBytes -= next.bytes.byteLength
    const startSequence = record.sentSequence
    record.sentSequence += next.bytes.byteLength
    record.ackSpans.push({
      throughSequence: record.sentSequence,
      hostBytes: next.hostBytes,
      sentAtMs: context.now()
    })
    context.post(record, {
      type: 'output',
      streamId: record.pageStreamId,
      startSequence,
      endSequence: record.sentSequence,
      data: Buffer.from(next.bytes).toString('base64')
    })
  }
}

function snapshotIdentifier(record: MobileWebTerminalStreamRecord): string {
  record.snapshotCounter += 1
  const value = new TextEncoder().encode(`${record.pageStreamId}:${record.snapshotCounter}`)
  return Buffer.from(sha256(value).subarray(0, 16))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
