import { createHash } from 'node:crypto'
import { asRecord, extractString, parseJsonObject } from './session-scanner-values'
import {
  reasonixCommittedBatches,
  type ReasonixCommittedBatch,
  type ReasonixPhysicalEvent
} from './session-scanner-reasonix-batches'

export const REASONIX_PROJECTION_KINDS = new Set([
  'message/complete',
  'message/upsert',
  'message/retract',
  'assistant/attempt',
  'tool/call',
  'tool/start',
  'tool/result',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'todo/write',
  'interaction/created',
  'interaction/resolved',
  'plan/state',
  'goal/state',
  'session/title',
  'session/config',
  'session/permission-preset',
  'model/context-replace',
  'history/replace',
  'compaction',
  'runtime/recovery',
  'legacy/import',
  'diagnostic'
])

const VISIBLE_HISTORY_KINDS = new Set([
  'message/complete',
  'message/upsert',
  'message/retract',
  'history/replace',
  'legacy/import',
  'session/title',
  'session/config'
])

export type ReasonixProjectedMessage = {
  id: string
  record: Record<string, unknown>
  timestamp: string | null
}
export type ReasonixHistoryProjection = {
  title: string | null
  model: string | null
  createdAt: string | null
  updatedAt: string | null
  messages: ReasonixProjectedMessage[]
}
export type ReasonixContentReader = (digest: string, bytes: number) => Promise<Buffer>

async function eventPayload(
  event: ReasonixPhysicalEvent,
  readContent?: ReasonixContentReader
): Promise<Record<string, unknown>> {
  let payload: Buffer
  if (event.payloadRef) {
    const { digest, bytes } = event.payloadRef
    if (
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > 8 * 1024 * 1024 ||
      !readContent
    ) {
      throw new Error('Unsupported Reasonix content reference or read budget')
    }
    payload = await readContent(digest, bytes)
    if (payload.length !== bytes || createHash('sha256').update(payload).digest('hex') !== digest) {
      throw new Error('Reasonix referenced payload integrity mismatch')
    }
  } else {
    if (
      event.payload === null ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.payload)
    ) {
      throw new Error('Invalid Reasonix inline payload')
    }
    payload = Buffer.from(event.payload, 'base64')
  }
  const record = parseJsonObject(payload.toString('utf8'))
  if (!record) {
    throw new Error('Invalid Reasonix event payload')
  }
  return record
}

function projectedMessage(
  value: unknown,
  timestamp: string | null,
  requireIdentity: boolean
): ReasonixProjectedMessage {
  const record = asRecord(value)
  if (
    !record ||
    (requireIdentity && !extractString(record.id)) ||
    (record.id != null && typeof record.id !== 'string')
  ) {
    throw new Error('Invalid Reasonix history message')
  }
  const createdAt =
    typeof record.createdAt === 'number' &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0
      ? new Date(record.createdAt).toISOString()
      : timestamp
  return { id: typeof record.id === 'string' ? record.id : '', record, timestamp: createdAt }
}

// Match native visible-history rewrites; compaction changes model context, not saved chat.
export async function projectReasonixHistory(
  bytes: AsyncIterable<Buffer>,
  readContent?: ReasonixContentReader,
  signal?: AbortSignal
): Promise<ReasonixHistoryProjection> {
  let referencedBytes = 0
  const boundedReadContent: ReasonixContentReader | undefined = readContent
    ? async (digest, size) => {
        referencedBytes += size
        if (referencedBytes > 64 * 1024 * 1024) {
          throw new Error('Reasonix referenced history exceeds read budget')
        }
        return readContent(digest, size)
      }
    : undefined
  const messages = new Map<string | symbol, ReasonixProjectedMessage>()
  const projection: ReasonixHistoryProjection = {
    title: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    messages: []
  }
  const batches: (ReasonixCommittedBatch | null)[] = []
  // Close the transcript lease before nested content reads use the host filesystem limiter.
  for await (const batch of reasonixCommittedBatches(bytes, REASONIX_PROJECTION_KINDS, signal)) {
    projection.createdAt ??= batch.createdAt
    projection.updatedAt = batch.createdAt ?? projection.updatedAt
    const events = batch.events.filter((event) => VISIBLE_HISTORY_KINDS.has(event.kind))
    if (events.length) {
      batches.push({ createdAt: batch.createdAt, events })
    }
  }
  for (let index = 0; index < batches.length; index++) {
    signal?.throwIfAborted()
    const batch = batches[index]
    batches[index] = null
    if (!batch) {
      continue
    }
    for (const event of batch.events) {
      signal?.throwIfAborted()
      if (!REASONIX_PROJECTION_KINDS.has(event.kind)) {
        continue
      }
      if (event.kind === 'message/complete' || event.kind === 'message/upsert') {
        const body = await eventPayload(event, boundedReadContent)
        const message = projectedMessage(body.message, batch.createdAt, true)
        if (event.kind === 'message/upsert' || !messages.has(message.id)) {
          messages.set(message.id, message)
        }
      } else if (event.kind === 'message/retract') {
        const body = await eventPayload(event, boundedReadContent)
        const ids = body.messageIds
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.some((id) => typeof id !== 'string' || !id.trim() || id.trim() !== id) ||
          new Set(ids).size !== ids.length
        ) {
          throw new Error('Invalid Reasonix retracted message identities')
        }
        for (const id of ids) {
          if (typeof id === 'string') {
            messages.delete(id)
          }
        }
      } else if (event.kind === 'history/replace' || event.kind === 'legacy/import') {
        const body = await eventPayload(event, boundedReadContent)
        if (!Array.isArray(body.messages)) {
          throw new Error('Invalid Reasonix history replacement')
        }
        messages.clear()
        for (const value of body.messages) {
          const message = projectedMessage(value, batch.createdAt, false)
          const key = message.id || Symbol()
          if (!messages.has(key)) {
            messages.set(key, message)
          }
        }
        if (event.kind === 'legacy/import') {
          projection.model = extractString(body.modelRef)
        }
      } else if (event.kind === 'session/title' || event.kind === 'session/config') {
        const body = await eventPayload(event, boundedReadContent)
        if (event.kind === 'session/title') {
          if (typeof body.title !== 'string') {
            throw new Error('Invalid Reasonix session title')
          }
          projection.title = extractString(body.title)
        } else {
          const model = extractString(body.modelRef)
          if (!model) {
            throw new Error('Invalid Reasonix session model')
          }
          projection.model = model
        }
      }
      if (messages.size > 50_000) {
        throw new Error('Reasonix messages exceed history read budget')
      }
    }
  }
  projection.messages = [...messages.values()]
  return projection
}
