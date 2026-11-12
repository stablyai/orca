import { afterEach, expect, it, vi } from 'vitest'
import { isAiVaultScanCancelledError } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../transcripts/session-transcript-record-budget'

type ChunkSource = {
  chunks: Buffer[]
  closed: boolean
  opens: number
  beforeChunk?: (index: number) => void
}

const source = vi.hoisted((): ChunkSource => ({ chunks: [], closed: false, opens: 0 }))
vi.mock('../../native-chat/wsl-transcript-fs-access', () => ({
  openTranscriptReadStream: async function* () {
    source.opens += 1
    source.closed = false
    try {
      for (const [index, chunk] of source.chunks.entries()) {
        source.beforeChunk?.(index)
        yield chunk
      }
    } finally {
      source.closed = true
    }
  }
}))

afterEach(() => {
  source.beforeChunk = undefined
  vi.restoreAllMocks()
})

// Arbitrary chunk cuts must preserve UTF-8, CRLF boundaries and byte-accurate resume offsets.
it('yields identical lines and resume offsets for every single-byte chunk split', async () => {
  const bigRecord = `{"d":${'"'.padEnd(2000, 'z')}"}`
  const expectedLines = [
    '{"a":1}',
    '{"b":"🦀 é 𝄞"}', // CRLF record whose content is 2/3/4-byte UTF-8
    '',
    '',
    '{"c":"x\ry"}', // lone CR inside a record
    bigRecord
  ]
  const trailing = '{"partial":'
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

// One oversized record must cost only that record and resume after its newline.
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
  const recordEnd = recordStart + OVERSIZED.length
  const start = 41

  // Exercise skip boundaries within one chunk and across multiple chunks.
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
    // Resume at the growing record start until its terminator is observed.
    consumedThrough: start + before.length,
    trailingPartialLine: null,
    bytesRead: growing.length,
    skippedRecords: [{ byteOffset: start + before.length, approximateBytes: OVERSIZED.length }]
  })

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

it('stops between chunks on cancel and releases the stream', async () => {
  source.chunks = [Buffer.from('{"a":1}\n'), Buffer.from('{"b":2}\n'), Buffer.from('{"c":3}\n')]
  const controller = new AbortController()
  const lines: string[] = []
  const read = consumeCompleteJsonlLines({
    path: '/log',
    start: 0,
    onLine: (line) => {
      lines.push(line)
      controller.abort()
    },
    signal: controller.signal
  })
  await expect(read).rejects.toSatisfy(isAiVaultScanCancelledError)
  expect(lines).toEqual(['{"a":1}'])
  expect(source.closed).toBe(true)
})

it('stops inside an over-budget record that is being discarded', async () => {
  const buffer = Buffer.from(`${OVERSIZED}${OVERSIZED}\n{"a":1}\n`, 'utf-8')
  source.chunks = chunksAt(buffer, OVERSIZED.length, OVERSIZED.length * 2)
  const controller = new AbortController()
  // The first chunk alone is over budget; cancel while the rest is still skipped.
  source.beforeChunk = (index) => {
    if (index === 1) {
      controller.abort()
    }
  }
  const onLine = vi.fn()
  const read = consumeCompleteJsonlLines({
    path: '/log',
    start: 0,
    onLine,
    signal: controller.signal
  })
  await expect(read).rejects.toSatisfy(isAiVaultScanCancelledError)
  expect(onLine).not.toHaveBeenCalled()
  expect(source.closed).toBe(true)
})
