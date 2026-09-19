import {
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferOutputFrame
} from '../shared/pty-ownership-transfer-wire'
import {
  RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX,
  type RelayPtyOwnershipTransferEmissionMemo,
  type RelayPtyOwnershipTransferOutputHistory,
  type RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import { MAX_OUTPUT_FRAME_BYTES } from './relay-pty-ownership-transfer-adapter-validation'
import {
  invalidJournal,
  requireRecord,
  positiveSequence
} from './relay-pty-ownership-transfer-journal-record-validation'

export function serializeObservedEmissions(
  transfer: RelayPtyOwnershipTransferRecord,
  history: RelayPtyOwnershipTransferOutputHistory,
  replayBytes: number
): readonly Readonly<{
  key: string
  data: string
  frames: readonly PtyOwnershipTransferOutputFrame[]
}>[] {
  const retained = new Map(history.frames.map((frame) => [frame.seq, frame]))
  let bytes = 0
  const result: {
    key: string
    data: string
    frames: readonly PtyOwnershipTransferOutputFrame[]
  }[] = []
  for (const memo of transfer.observedEmissions.values()) {
    const dataBytes = Buffer.byteLength(memo.data, 'utf8')
    if (
      !memo.key ||
      !memo.data ||
      dataBytes > replayBytes ||
      bytes + dataBytes > replayBytes ||
      memo.frames.length === 0 ||
      memo.frames.some((frame) => {
        const retainedFrame = retained.get(frame.seq)
        return !retainedFrame || retainedFrame.data !== frame.data || frame.truncated === true
      })
    ) {
      continue
    }
    result.push({ key: memo.key, data: memo.data, frames: structuredClone(memo.frames) })
    bytes += dataBytes
    if (result.length >= RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX) {
      break
    }
  }
  return result
}

export function parseObservedEmissions(
  value: unknown,
  history: RelayPtyOwnershipTransferOutputHistory,
  identity: RelayPtyOwnershipTransferRecord['identity'],
  replayBytes: number
): Map<string, RelayPtyOwnershipTransferEmissionMemo> {
  if (value === undefined) {
    return new Map()
  }
  if (!Array.isArray(value) || value.length > RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX) {
    throw invalidJournal()
  }
  const retained = new Map(history.frames.map((frame) => [frame.seq, frame]))
  const result = new Map<string, RelayPtyOwnershipTransferEmissionMemo>()
  let bytes = 0
  for (const candidate of value) {
    const record = requireRecord(candidate)
    if (
      typeof record.key !== 'string' ||
      record.key.length === 0 ||
      record.key.length > 256 ||
      typeof record.data !== 'string' ||
      record.data.length === 0 ||
      result.has(record.key) ||
      !Array.isArray(record.frames) ||
      record.frames.length === 0
    ) {
      throw invalidJournal()
    }
    const frames = parseMemoFrames(record.frames, retained, record.data)
    const dataBytes = Buffer.byteLength(record.data, 'utf8')
    if (dataBytes > replayBytes || bytes + dataBytes > replayBytes) {
      throw invalidJournal()
    }
    const fragments = frames.map((frame) =>
      Object.freeze({
        data: frame.data,
        ownershipTransfer: Object.freeze({
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          frameSeq: frame.seq,
          fragmentStartSu: 0,
          fragmentEndSu: frame.data.length,
          frameLengthSu: frame.data.length
        })
      })
    )
    result.set(record.key, {
      key: record.key,
      data: record.data,
      frames: Object.freeze(frames),
      fragments: Object.freeze(fragments)
    })
    bytes += dataBytes
  }
  return result
}

function parseMemoFrames(
  value: readonly unknown[],
  retained: ReadonlyMap<number, PtyOwnershipTransferOutputFrame>,
  data: string
): PtyOwnershipTransferOutputFrame[] {
  const frames: PtyOwnershipTransferOutputFrame[] = []
  let expected: number | undefined
  let concatenated = ''
  for (const candidate of value) {
    const record = requireRecord(candidate)
    const seq = positiveSequence(record.seq)
    if (
      typeof record.data !== 'string' ||
      record.data.length === 0 ||
      record.truncated !== undefined ||
      (expected !== undefined && seq !== expected) ||
      retained.get(seq)?.data !== record.data
    ) {
      throw invalidJournal()
    }
    const frame = Object.freeze({ seq, data: record.data })
    frames.push(frame)
    concatenated += record.data
    expected = seq + 1
  }
  if (concatenated !== data) {
    throw invalidJournal()
  }
  return frames
}

export function parseHistory(
  value: unknown,
  replayBytes: number
): RelayPtyOwnershipTransferOutputHistory {
  const record = requireRecord(value)
  const nextSeq = positiveSequence(record.nextSeq)
  if (!Array.isArray(record.frames)) {
    throw invalidJournal()
  }
  let retainedBytes = 0
  let previousSeq: number | undefined
  const frames: PtyOwnershipTransferOutputFrame[] = record.frames.map((value) => {
    const frame = requireRecord(value)
    const seq = positiveSequence(frame.seq)
    if (
      typeof frame.data !== 'string' ||
      frame.data.length === 0 ||
      frame.truncated !== undefined ||
      (previousSeq !== undefined && seq !== previousSeq + 1)
    ) {
      throw invalidJournal()
    }
    const bytes = Buffer.byteLength(frame.data, 'utf8')
    if (bytes > MAX_OUTPUT_FRAME_BYTES) {
      throw invalidJournal()
    }
    retainedBytes += bytes
    previousSeq = seq
    return Object.freeze({ seq, data: frame.data })
  })
  if (retainedBytes > replayBytes || (frames.length > 0 && frames.at(-1)!.seq !== nextSeq - 1)) {
    throw invalidJournal()
  }
  return { nextSeq, retainedBytes, frames }
}
