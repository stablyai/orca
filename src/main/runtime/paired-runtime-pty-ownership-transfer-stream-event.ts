import { parsePtyOwnershipTransferExitEvent } from '../../shared/pty-ownership-transfer-control-wire'
import type {
  PtyOwnershipTransferOutputCredit,
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferOutputCredit,
  parsePtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'

export type ParsedPtyOwnershipTransferSourceStreamEvent =
  | {
      kind: 'ready'
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      outputCredit?: PtyOwnershipTransferOutputCredit
    }
  | {
      kind: 'output'
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      frame: PtyOwnershipTransferOutputFrame
    }
  | { kind: 'exit'; event: ReturnType<typeof parsePtyOwnershipTransferExitEvent> }
  | { kind: 'loss'; code: string }

export function parsePtyOwnershipTransferSourceStreamEvent(
  value: unknown
): ParsedPtyOwnershipTransferSourceStreamEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_stream_event_invalid')
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'ready') {
    return parseReadyEvent(record)
  }
  if (record.kind === 'loss') {
    if (typeof record.code !== 'string' || !record.code) {
      throw new Error('pty_ownership_transfer_stream_loss_invalid')
    }
    return { kind: 'loss', code: record.code }
  }
  if (record.kind === 'exit') {
    return { kind: 'exit', event: parsePtyOwnershipTransferExitEvent(record.event) }
  }
  if (record.kind !== 'output') {
    throw new Error('pty_ownership_transfer_stream_event_invalid')
  }
  return parseOutputEvent(record)
}

export function acceptPtyOwnershipTransferOutputSequence(
  cursor: { seq: number; frame: PtyOwnershipTransferOutputFrame } | undefined,
  frame: PtyOwnershipTransferOutputFrame
): Readonly<{
  accepted: boolean
  cursor: { seq: number; frame: PtyOwnershipTransferOutputFrame }
}> {
  if (frame.truncated === true) {
    throw new Error('pty_ownership_transfer_stream_frame_truncated')
  }
  if (!cursor) {
    return Object.freeze({ accepted: true, cursor: { seq: frame.seq, frame } })
  }
  if (frame.seq === cursor.seq) {
    if (frame.data !== cursor.frame.data || frame.truncated !== cursor.frame.truncated) {
      throw new Error('pty_ownership_transfer_stream_frame_conflict')
    }
    return Object.freeze({ accepted: false, cursor })
  }
  if (frame.seq !== cursor.seq + 1) {
    throw new Error('pty_ownership_transfer_stream_sequence_gap')
  }
  return Object.freeze({ accepted: true, cursor: { seq: frame.seq, frame } })
}

function parseReadyEvent(
  record: Record<string, unknown>
): Extract<ParsedPtyOwnershipTransferSourceStreamEvent, { kind: 'ready' }> {
  const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  const attachmentId = parseAttachmentId(record.attachmentId)
  const outputCredit =
    record.outputCredit === undefined
      ? undefined
      : parsePtyOwnershipTransferOutputCredit(record.outputCredit)
  return {
    kind: 'ready',
    identity,
    attachmentId,
    ...(outputCredit ? { outputCredit } : {})
  }
}

function parseOutputEvent(
  record: Record<string, unknown>
): Extract<ParsedPtyOwnershipTransferSourceStreamEvent, { kind: 'output' }> {
  const frame = record.frame
  if (
    !frame ||
    typeof frame !== 'object' ||
    Array.isArray(frame) ||
    !Number.isSafeInteger((frame as Record<string, unknown>).seq) ||
    Number((frame as Record<string, unknown>).seq) < 1 ||
    typeof (frame as Record<string, unknown>).data !== 'string' ||
    ((frame as Record<string, unknown>).truncated !== undefined &&
      typeof (frame as Record<string, unknown>).truncated !== 'boolean')
  ) {
    throw new Error('pty_ownership_transfer_stream_frame_invalid')
  }
  const frameRecord = frame as Record<string, unknown>
  return {
    kind: 'output',
    identity: parsePtyOwnershipTransferWireIdentity(record.identity),
    attachmentId: parseAttachmentId(record.attachmentId),
    frame: {
      seq: Number(frameRecord.seq),
      data: frameRecord.data as string,
      ...(frameRecord.truncated === undefined
        ? {}
        : { truncated: frameRecord.truncated as boolean })
    }
  }
}

function parseAttachmentId(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('pty_ownership_transfer_stream_attachment_invalid')
  }
  return value
}
