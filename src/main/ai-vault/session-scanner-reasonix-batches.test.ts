import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { reasonixCommittedBatches } from './session-scanner-reasonix-batches'
import { reasonixFrameRecords } from './session-scanner-reasonix-frames'
import { projectReasonixHistory } from './session-scanner-reasonix-projection'
import { asRecord, parseJsonObject } from './session-scanner-values'

const kinds = new Set([
  'message/complete',
  'session/config',
  'turn/start',
  'turn/end',
  'assistant/attempt'
])
const real = readFileSync(join(__dirname, '__fixtures__', 'reasonix-1-39-7-loopback.frames'))
async function* chunks(content: Buffer) {
  for (let at = 0; at < content.length; at += 17) {
    yield content.subarray(at, at + 17)
  }
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of source) {
    result.push(item)
  }
  return result
}
function frame(raw: Buffer): Buffer {
  const compressed = zstdCompressSync(raw, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const header = Buffer.alloc(12)
  header.write('RX4F')
  header.writeUInt32BE(compressed.length, 4)
  header.writeUInt32BE(raw.length, 8)
  return Buffer.concat([header, compressed])
}
function batch(
  kind = 'message/complete',
  optional = false,
  payload: unknown = { message: { id: 'm', role: 'user', content: 'test' } },
  sequence = 1
): Buffer[] {
  const records = [
    {
      schemaVersion: 4,
      codec: 'reasonix.session.linear/v4',
      recordType: 'batch/begin',
      commitId: `commit-${sequence}`,
      operationId: `op-${sequence}`,
      operationHash: 'hash',
      firstSeq: sequence,
      eventCount: 1,
      writerGeneration: 1
    },
    {
      schemaVersion: 4,
      codec: 'reasonix.session.linear/v4',
      recordType: 'batch/event',
      event: {
        id: 'event',
        seq: sequence,
        kind,
        optional,
        payload: Buffer.from(JSON.stringify(payload)).toString('base64')
      }
    }
  ].map((record) => Buffer.from(JSON.stringify(record)))
  const digest = createHash('sha256')
  for (const raw of records) {
    digest.update(raw).update('\0')
  }
  const end = Buffer.from(
    JSON.stringify({
      schemaVersion: 4,
      codec: 'reasonix.session.linear/v4',
      recordType: 'batch/end',
      commitId: `commit-${sequence}`,
      firstSeq: sequence,
      eventCount: 1,
      sha256: digest.digest('hex')
    })
  )
  return [...records, end]
}

it('validates the actual released binary history across split frame headers', async () => {
  const batches = await collect(reasonixCommittedBatches(chunks(real), kinds))
  const payloads = batches
    .flatMap((batch) => batch.events)
    .flatMap((event) =>
      event.payload ? [Buffer.from(event.payload, 'base64').toString('utf8')] : []
    )
  expect(payloads.some((payload) => payload.includes('Orca loopback transport probe'))).toBe(true)
  expect(payloads.some((payload) => payload.includes('Loopback transport proof only.'))).toBe(true)
})

it('does not publish an uncommitted tail, including an unknown pending event', async () => {
  const raw = batch('future-required')
  expect(
    await collect(
      reasonixCommittedBatches(chunks(Buffer.concat(raw.slice(0, 2).map(frame))), kinds)
    )
  ).toEqual([])
  const frames = raw.map(frame)
  expect(
    await collect(
      reasonixCommittedBatches(
        chunks(Buffer.concat([frames[0], frames[1], frames[2].subarray(0, 15)])),
        kinds
      )
    )
  ).toEqual([])
})

it('rejects a damaged transaction digest even when frame checksums are valid', async () => {
  const raw = batch()
  raw[2] = Buffer.from(raw[2].toString().replace('"sha256":"', '"sha256":"0'))
  await expect(
    collect(reasonixCommittedBatches(chunks(Buffer.concat(raw.map(frame))), kinds))
  ).rejects.toThrow('checksum')
})

it('rejects a corrupt native Zstandard checksum', async () => {
  const compressed = frame(batch()[0])
  compressed[compressed.length - 1] ^= 1
  await expect(collect(reasonixFrameRecords(chunks(compressed)))).rejects.toThrow()
})

it('rejects an event sequence gap before exposing any batch', async () => {
  const raw = batch()
  raw[1] = Buffer.from(raw[1].toString().replace('"seq":1', '"seq":2'))
  await expect(
    collect(reasonixCommittedBatches(chunks(Buffer.concat(raw.map(frame))), kinds))
  ).rejects.toThrow('batch event')
})

it('ignores a huge uncommitted event count without preallocating its events', async () => {
  const raw = batch()
  raw[0] = Buffer.from(raw[0].toString().replace('"eventCount":1', '"eventCount":2147483647'))
  expect(await collect(reasonixCommittedBatches(chunks(frame(raw[0])), kinds))).toEqual([])
})

it('fails closed on a committed unknown required event but permits optional evolution', async () => {
  await expect(
    collect(
      reasonixCommittedBatches(chunks(Buffer.concat(batch('future-required').map(frame))), kinds)
    )
  ).rejects.toThrow('required event')
  expect(
    await collect(
      reasonixCommittedBatches(
        chunks(Buffer.concat(batch('future-optional', true).map(frame))),
        kinds
      )
    )
  ).toHaveLength(1)
})

it('rejects declared frame sizes before allocating or reading their body', async () => {
  const header = Buffer.alloc(12)
  header.write('RX4F')
  header.writeUInt32BE(0xffffffff, 4)
  header.writeUInt32BE(1, 8)
  await expect(collect(reasonixFrameRecords(chunks(header)))).rejects.toThrow('sizes')
})

it('bounds cumulative decoded output across highly compressed native-sized frames', async () => {
  const compressed = frame(Buffer.alloc(8 * 1024 * 1024, 'x'))
  async function* source() {
    for (let index = 0; index < 9; index += 1) {
      yield compressed
    }
  }
  const drain = async () => {
    for await (const _record of reasonixFrameRecords(source())) {
      // Discard records so the test also exercises bounded reader retention.
    }
  }
  await expect(drain()).rejects.toThrow('decoded history exceeds read budget')
})

it('closes its source when the consumer stops early', async () => {
  let closed = false
  async function* source() {
    try {
      yield real
    } finally {
      closed = true
    }
  }
  for await (const _batch of reasonixCommittedBatches(source(), kinds)) {
    break
  }
  expect(closed).toBe(true)
})

it('cancels before requesting more source bytes', async () => {
  const controller = new AbortController()
  controller.abort()
  let read = false
  async function* source() {
    read = true
    yield real
  }
  await expect(collect(reasonixFrameRecords(source(), controller.signal))).rejects.toThrow()
  expect(read).toBe(false)
})

it('projects the actual native saved model and user/assistant records', async () => {
  const projection = await projectReasonixHistory(chunks(real))
  expect(projection.model).toBe('orca-proof/orca-loopback')
  expect(
    projection.messages
      .filter((message) => message.record.origin === 'user')
      .map((message) => message.record.raw_content)
  ).toEqual(['Orca loopback transport probe'])
  expect(
    projection.messages
      .filter((message) => message.record.role === 'assistant')
      .map((message) => message.record.content)
  ).toEqual(['Loopback transport proof only.'])
})

it('honors native replacements, upserts and retractions instead of indexing stale messages', async () => {
  const events = [
    batch(),
    batch('message/upsert', false, { message: { id: 'm', role: 'user', content: 'edited' } }, 2),
    batch(
      'message/complete',
      false,
      { message: { id: 'a', role: 'assistant', content: 'answer' } },
      3
    ),
    batch('message/retract', false, { messageIds: ['m'] }, 4),
    batch(
      'history/replace',
      false,
      {
        messages: [
          { id: 'r', role: 'user', content: 'replacement' },
          { id: 'r', role: 'user', content: 'duplicate' }
        ]
      },
      5
    ),
    batch(
      'compaction',
      false,
      { messages: [{ id: 'model', role: 'system', content: 'model-only summary' }] },
      6
    )
  ]
    .flat()
    .map(frame)
  const projection = await projectReasonixHistory(chunks(Buffer.concat(events)))
  expect(projection.messages.map((message) => message.record.content)).toEqual(['replacement'])
})

function referencedBatch(contentDigest: string, size: number, sequence = 1): Buffer[] {
  const raw = batch('message/complete', false, {}, sequence)
  const record = parseJsonObject(raw[1].toString())
  const event = asRecord(record?.event)
  const end = parseJsonObject(raw[2].toString())
  if (!record || !event || !end) {
    throw new Error('Invalid generated Reasonix physical fixture')
  }
  delete event.payload
  event.payloadRef = { digest: contentDigest, bytes: size }
  raw[1] = Buffer.from(JSON.stringify(record))
  const digest = createHash('sha256')
  for (const record of raw.slice(0, 2)) {
    digest.update(record).update('\0')
  }
  end.sha256 = digest.digest('hex')
  raw[2] = Buffer.from(JSON.stringify(end))
  return raw
}

it('fails closed on a malformed referenced-payload digest before requesting content', async () => {
  let read = false
  await expect(
    projectReasonixHistory(
      chunks(Buffer.concat(referencedBatch('../outside', 10).map(frame))),
      async () => {
        read = true
        return Buffer.alloc(10)
      }
    )
  ).rejects.toThrow('content reference')
  expect(read).toBe(false)
})

it('accepts immutable content only when both native byte length and SHA-256 match', async () => {
  const content = Buffer.from(
    JSON.stringify({ message: { id: 'ref', role: 'user', origin: 'user', content: 'referenced' } })
  )
  const digest = createHash('sha256').update(content).digest('hex')
  const log = Buffer.concat(referencedBatch(digest, content.length).map(frame))
  const projection = await projectReasonixHistory(chunks(log), async () => content)
  expect(projection.messages.map((message) => message.record.content)).toEqual(['referenced'])
  const changed = Buffer.from(content)
  changed[changed.length - 1] ^= 1
  await expect(projectReasonixHistory(chunks(log), async () => changed)).rejects.toThrow(
    'integrity mismatch'
  )
})

it('bounds referenced content across commits before requesting another large object', async () => {
  const content = Buffer.from(
    JSON.stringify({
      message: { id: 'big', role: 'user', content: 'x'.repeat(8 * 1024 * 1024 - 512) }
    })
  )
  const digest = createHash('sha256').update(content).digest('hex')
  const log = Buffer.concat(
    Array.from({ length: 9 }, (_, index) => referencedBatch(digest, content.length, index + 1))
      .flat()
      .map(frame)
  )
  let reads = 0
  await expect(
    projectReasonixHistory(chunks(log), async () => {
      reads += 1
      return content
    })
  ).rejects.toThrow('referenced history exceeds read budget')
  expect(reads).toBe(8)
})

it('closes the transcript source before requesting referenced content', async () => {
  const content = Buffer.from(
    JSON.stringify({ message: { id: 'ref', role: 'user', content: 'nested read' } })
  )
  const digest = createHash('sha256').update(content).digest('hex')
  let closed = false
  async function* source() {
    try {
      yield Buffer.concat(referencedBatch(digest, content.length).map(frame))
    } finally {
      closed = true
    }
  }
  const projection = await projectReasonixHistory(source(), async () => {
    expect(closed).toBe(true)
    return content
  })
  expect(projection.messages.map((message) => message.record.content)).toEqual(['nested read'])
})
