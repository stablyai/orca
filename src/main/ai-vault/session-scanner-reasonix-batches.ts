import { createHash, type Hash } from 'node:crypto'
import { asRecord, extractString, parseJsonObject } from './session-scanner-values'
import { reasonixFrameRecords } from './session-scanner-reasonix-frames'

export type ReasonixPhysicalEvent = {
  kind: string
  optional: boolean
  payload: string | null
  payloadRef: Record<string, unknown> | null
}
export type ReasonixCommittedBatch = {
  createdAt: string | null
  events: ReasonixPhysicalEvent[]
}

type PendingBatch = ReasonixCommittedBatch & {
  id: string
  operationId: string
  operationHash: string
  firstSeq: number
  eventCount: number
  bytes: number
  digest: Hash
}
const MAX_BATCH_BYTES = 32 * 1024 * 1024

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

// Project only complete native atomic commits; an interrupted append has no authority.
export async function* reasonixCommittedBatches(
  bytes: AsyncIterable<Buffer>,
  knownKinds: ReadonlySet<string>,
  signal?: AbortSignal
): AsyncGenerator<ReasonixCommittedBatch> {
  let pending: PendingBatch | null = null
  let nextSequence = 1
  const operations = new Map<string, string>()
  for await (const raw of reasonixFrameRecords(bytes, signal)) {
    const record = parseJsonObject(raw.toString('utf8'))
    if (record?.schemaVersion !== 4 || record.codec !== 'reasonix.session.linear/v4') {
      throw new Error('Unsupported Reasonix history format; update the transcript-owning Orca host')
    }
    if (record.recordType === 'batch/begin') {
      const id = extractString(record.commitId)
      const operationId = extractString(record.operationId)
      const operationHash = extractString(record.operationHash)
      if (
        pending ||
        !id ||
        !operationId ||
        !operationHash ||
        !positiveInteger(record.writerGeneration) ||
        record.firstSeq !== nextSequence ||
        !positiveInteger(record.eventCount)
      ) {
        throw new Error('Invalid Reasonix batch boundary')
      }
      pending = {
        id,
        operationId,
        operationHash,
        firstSeq: nextSequence,
        eventCount: record.eventCount,
        createdAt: extractString(record.createdAt),
        events: [],
        bytes: raw.length,
        digest: createHash('sha256').update(raw).update('\0')
      }
    } else if (record.recordType === 'batch/event') {
      const event = asRecord(record.event)
      const kind = extractString(event?.kind)
      if (
        !pending ||
        !event ||
        !extractString(event.id) ||
        !kind ||
        pending.events.length >= pending.eventCount ||
        event.seq !== pending.firstSeq + pending.events.length ||
        (event.optional != null && typeof event.optional !== 'boolean') ||
        (event.required != null && typeof event.required !== 'boolean') ||
        (event.payloadRef != null && event.payload != null) ||
        (event.payload != null && typeof event.payload !== 'string')
      ) {
        throw new Error('Invalid Reasonix batch event')
      }
      const payloadRef = event.payloadRef == null ? null : asRecord(event.payloadRef)
      if (event.payloadRef != null && !payloadRef) {
        throw new Error('Invalid Reasonix content reference')
      }
      pending.bytes += raw.length
      if (pending.bytes > MAX_BATCH_BYTES) {
        throw new Error('Reasonix batch exceeds history read budget')
      }
      pending.events.push({
        kind,
        optional: event.optional === true,
        payload: typeof event.payload === 'string' ? event.payload : null,
        payloadRef
      })
      pending.digest.update(raw).update('\0')
    } else if (record.recordType === 'batch/end') {
      if (
        !pending ||
        record.commitId !== pending.id ||
        record.firstSeq !== pending.firstSeq ||
        record.eventCount !== pending.eventCount ||
        pending.events.length !== pending.eventCount ||
        record.sha256 !== pending.digest.digest('hex')
      ) {
        throw new Error('Invalid Reasonix batch end or checksum')
      }
      const previousHash = operations.get(pending.operationId)
      if (previousHash !== undefined && previousHash !== pending.operationHash) {
        throw new Error('Conflicting Reasonix operation identity')
      }
      operations.set(pending.operationId, pending.operationHash)
      for (const event of pending.events) {
        if (!event.optional && !knownKinds.has(event.kind)) {
          throw new Error(`Unsupported Reasonix required event: ${event.kind}`)
        }
      }
      nextSequence = pending.firstSeq + pending.eventCount
      if (!Number.isSafeInteger(nextSequence)) {
        throw new Error('Invalid Reasonix event sequence')
      }
      const committed = pending
      pending = null
      yield { createdAt: committed.createdAt, events: committed.events }
    } else {
      throw new Error('Unsupported Reasonix physical record')
    }
  }
}
