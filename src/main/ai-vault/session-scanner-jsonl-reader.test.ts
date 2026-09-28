import { expect, it, vi } from 'vitest'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'

const source = vi.hoisted(() => {
  const chunks: Buffer[] = []
  return { chunks, closed: false }
})
vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  openTranscriptReadStream: async function* () {
    source.closed = false
    try {
      yield* source.chunks
    } finally {
      source.closed = true
    }
  }
}))

it('copies only the carried line when the next chunk contains many complete lines', async () => {
  source.chunks = Array.from({ length: 100 }, () => Buffer.from(`${'a\n'.repeat(1000)}x`))
  const original = Buffer.concat
  let copied = 0
  const concat = vi.spyOn(Buffer, 'concat').mockImplementation((chunks, total) => {
    copied += total ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    return original(chunks, total)
  })
  let lines = 0
  let result: Awaited<ReturnType<typeof consumeCompleteJsonlLines>>
  try {
    result = await consumeCompleteJsonlLines({
      path: '/log',
      start: 0,
      onLine: () => {
        lines += 1
      }
    })
  } finally {
    concat.mockRestore()
  }
  expect(lines).toBe(100000)
  expect(result!).toEqual({
    consumedThrough: 200099,
    trailingPartialLine: 'x',
    bytesRead: 200100,
    skippedRecords: []
  })
  expect(copied).toBeLessThan(1000)
})

it('preserves UTF-8/CRLF carry, byte callbacks and stop offsets', async () => {
  source.chunks = [Buffer.from('ab\r'), Buffer.from('\ncd\npartial')]
  const lines: string[] = []
  expect(
    await consumeCompleteJsonlLines({
      path: '/log',
      start: 5,
      onLine: () => {},
      onLineBytes: (line) => lines.push(line.toString())
    })
  ).toEqual({
    consumedThrough: 12,
    trailingPartialLine: 'partial',
    bytesRead: 14,
    skippedRecords: []
  })
  expect(lines).toEqual(['ab', 'cd'])
  let stopped = false
  expect(
    await consumeCompleteJsonlLines({
      path: '/log',
      start: 5,
      onLine: () => {
        stopped = true
      },
      shouldStop: () => stopped
    })
  ).toEqual({ consumedThrough: 9, trailingPartialLine: null, bytesRead: 14, skippedRecords: [] })
  const unicode = Buffer.from('🦀\n')
  source.chunks = [unicode.subarray(0, 2), unicode.subarray(2)]
  const onLine = vi.fn()
  await consumeCompleteJsonlLines({ path: '/log', start: 0, onLine })
  expect(onLine).toHaveBeenCalledWith('🦀')
})

// Why: a chunk boundary is not aligned to anything — it can land mid-record,
// mid-UTF-8-sequence, between CR and LF, or on an empty line. A dropped or
// merged line here silently corrupts an agent transcript, and a wrong
// `consumedThrough` makes the next incremental scan resume mid-line.
it('yields identical lines and resume offsets for every single-byte chunk split', async () => {
  const bigRecord = `{"d":${'"'.padEnd(2000, 'z')}"}`
  const expectedLines = [
    '{"a":1}', // plain LF record
    '{"b":"🦀 é 𝄞"}', // CRLF record whose content is 2/3/4-byte UTF-8
    '', // empty line
    '', // empty CRLF line
    '{"c":"x\ry"}', // lone CR inside a record
    bigRecord // single record larger than any carried prefix
  ]
  const trailing = '{"partial":' // final line with no trailing newline
  const buffer = Buffer.from(
    `{"a":1}\n{"b":"🦀 é 𝄞"}\r\n\n\r\n{"c":"x\ry"}\n${bigRecord}\n${trailing}`,
    'utf-8'
  )
  const expectedConsumed = buffer.length - Buffer.byteLength(trailing)

  for (let cut = 0; cut <= buffer.length; cut++) {
    source.chunks = [buffer.subarray(0, cut), buffer.subarray(cut)].filter((c) => c.length > 0)
    const lines: string[] = []
    const result = await consumeCompleteJsonlLines({
      path: '/log',
      start: 41,
      onLine: (line) => lines.push(line)
    })
    expect({ cut, lines, ...result }).toEqual({
      cut,
      lines: expectedLines,
      consumedThrough: 41 + expectedConsumed,
      trailingPartialLine: trailing,
      bytesRead: buffer.length,
      skippedRecords: []
    })
  }
})

// Why: a single 10 MiB base64 image used to abort the fold, which dropped the
// whole session from the vault. Skipping must cost exactly one record, and the
// resume cursor must land on the byte after that record's newline — anything
// else makes the next incremental scan resume mid-line.
const OVERSIZED = 'x'.repeat(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1)

function chunksAt(buffer: Buffer, ...cuts: number[]): Buffer[] {
  const bounds = [0, ...cuts, buffer.length]
  return bounds
    .slice(0, -1)
    .map((from, index) => buffer.subarray(from, bounds[index + 1]))
    .filter((chunk) => chunk.length > 0)
}

it('drops one oversized record and folds the rest of the session', async () => {
  const before = '{"a":1}\n'
  const after = '{"b":2}\n{"c":3}\n'
  const buffer = Buffer.from(`${before}${OVERSIZED}\n${after}`, 'utf-8')
  const recordStart = before.length
  const recordEnd = recordStart + OVERSIZED.length // index of the terminating '\n'
  const start = 41

  // Every cut that can land somewhere structurally different: inside the
  // surviving prefix, at each edge of the skipped span, and mid-skip. The
  // multi-cut rows carry one skip across three and five chunks.
  const layouts: number[][] = [
    [],
    [3],
    [recordStart],
    [recordStart + 1],
    [recordStart + 4096],
    [recordEnd - 1],
    [recordEnd],
    [recordEnd + 1],
    [recordEnd + 1 + 3],
    [recordStart, recordEnd],
    [recordStart, recordEnd + 1],
    [recordStart + 1, recordEnd - 1],
    [3, recordStart + 7, recordEnd, recordEnd + 1, recordEnd + 9],
    [1, 2, recordStart + 1, recordEnd - 2, recordEnd + 2]
  ]
  for (const cuts of layouts) {
    source.chunks = chunksAt(buffer, ...cuts)
    const lines: string[] = []
    const result = await consumeCompleteJsonlLines({
      path: '/log',
      start,
      onLine: (line) => lines.push(line)
    })
    expect({ cuts, lines, ...result }).toEqual({
      cuts,
      lines: ['{"a":1}', '{"b":2}', '{"c":3}'],
      // The cursor sits past the whole file: the skipped span is consumed, not re-read.
      consumedThrough: start + buffer.length,
      trailingPartialLine: null,
      bytesRead: buffer.length,
      skippedRecords: [{ byteOffset: start + recordStart, approximateBytes: OVERSIZED.length }]
    })
  }
})

it('leaves the cursor before an unterminated oversized tail and skips it once terminated', async () => {
  const before = '{"a":1}\n'
  const start = 41
  const growing = Buffer.from(`${before}${OVERSIZED}`, 'utf-8')
  source.chunks = chunksAt(growing, before.length + 1, before.length + 5000)
  const firstLines: string[] = []
  const first = await consumeCompleteJsonlLines({
    path: '/log',
    start,
    onLine: (line) => firstLines.push(line)
  })
  expect(firstLines).toEqual(['{"a":1}'])
  expect(first).toEqual({
    // Held at the record's start: an unterminated record may still be growing,
    // so the next read re-reads it rather than guessing where it ends.
    consumedThrough: start + before.length,
    trailingPartialLine: null,
    bytesRead: growing.length,
    skippedRecords: [{ byteOffset: start + before.length, approximateBytes: OVERSIZED.length }]
  })

  // The next read resumes at that offset; the record is complete now.
  const rest = Buffer.from(`${OVERSIZED}\n{"b":2}\n`, 'utf-8')
  source.chunks = chunksAt(rest, 7, OVERSIZED.length, OVERSIZED.length + 1)
  const restLines: string[] = []
  const second = await consumeCompleteJsonlLines({
    path: '/log',
    start: first.consumedThrough,
    onLine: (line) => restLines.push(line)
  })
  expect(restLines).toEqual(['{"b":2}'])
  expect(second).toEqual({
    consumedThrough: start + before.length + rest.length,
    trailingPartialLine: null,
    bytesRead: rest.length,
    skippedRecords: [{ byteOffset: start + before.length, approximateBytes: OVERSIZED.length }]
  })
})

it('skips back-to-back oversized records without losing the cursor', async () => {
  const buffer = Buffer.from(`${OVERSIZED}\n${OVERSIZED}\n{"a":1}\n`, 'utf-8')
  source.chunks = chunksAt(buffer, 1, OVERSIZED.length + 1, OVERSIZED.length * 2 + 2)
  const lines: string[] = []
  const result = await consumeCompleteJsonlLines({
    path: '/log',
    start: 0,
    onLine: (line) => lines.push(line)
  })
  expect(lines).toEqual(['{"a":1}'])
  expect(result.consumedThrough).toBe(buffer.length)
  expect(result.skippedRecords).toEqual([
    { byteOffset: 0, approximateBytes: OVERSIZED.length },
    { byteOffset: OVERSIZED.length + 1, approximateBytes: OVERSIZED.length }
  ])
})

it('accepts records exactly at the byte cap and a larger file of separate records', async () => {
  const line = Buffer.alloc(MAX_SESSION_TRANSCRIPT_RECORD_BYTES, 'x')
  source.chunks = [line, Buffer.from('\n'), line, Buffer.from('\n'), line]
  const lengths: number[] = []
  const result = await consumeCompleteJsonlLines({
    path: '/log',
    start: 41,
    onLine: () => {},
    onLineBytes: (bytes) => lengths.push(bytes.length)
  })
  expect(lengths).toEqual([line.length, line.length])
  expect({ ...result, trailingPartialLine: result.trailingPartialLine?.length }).toEqual({
    consumedThrough: 41 + 2 * (line.length + 1),
    trailingPartialLine: line.length,
    bytesRead: 3 * line.length + 2,
    skippedRecords: []
  })
})

it('counts UTF-8 bytes instead of decoded characters at the record cap', async () => {
  const chars = Math.floor(MAX_SESSION_TRANSCRIPT_RECORD_BYTES / 3)
  source.chunks = [Buffer.from('界'.repeat(chars)), Buffer.from('界\n{"a":1}\n')]
  const lines: string[] = []
  const result = await consumeCompleteJsonlLines({
    path: '/log',
    start: 0,
    onLine: (line) => lines.push(line)
  })
  expect(lines).toEqual(['{"a":1}'])
  expect(result.skippedRecords).toEqual([{ byteOffset: 0, approximateBytes: 3 * (chars + 1) }])
  expect(result.consumedThrough).toBe(3 * (chars + 1) + 1 + 8)
})
