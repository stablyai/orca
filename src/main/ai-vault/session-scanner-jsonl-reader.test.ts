import { expect, it, vi } from 'vitest'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'

const source = vi.hoisted(() => ({ chunks: [] as Buffer[] }))
vi.mock('../native-chat/wsl-transcript-fs-access', () => ({
  openTranscriptReadStream: async function* () {
    yield* source.chunks
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
  expect(result!).toEqual({ consumedThrough: 200099, trailingPartialLine: 'x', bytesRead: 200100 })
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
  ).toEqual({ consumedThrough: 12, trailingPartialLine: 'partial', bytesRead: 14 })
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
  ).toEqual({ consumedThrough: 9, trailingPartialLine: null, bytesRead: 14 })
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
      bytesRead: buffer.length
    })
  }
})
