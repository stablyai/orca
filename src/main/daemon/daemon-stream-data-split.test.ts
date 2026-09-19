import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import {
  encodeStreamDataEvent,
  splitStreamDataForNdjson,
  writeStreamDataEvents
} from './daemon-stream-data-split'
import { encodeNdjson } from './ndjson'

vi.mock('./ndjson', async (importOriginal) => {
  const actual = await importOriginal<{ encodeNdjson: typeof encodeNdjson }>()
  return { ...actual, encodeNdjson: vi.fn(actual.encodeNdjson) }
})

function write(
  data: string,
  maxLineBytes: number,
  rawLength = data.length,
  seq?: number,
  transformed = false,
  sessionId = 'session-1'
): string[] {
  const lines: string[] = []
  const socket: Pick<Socket, 'write'> = {
    write: vi.fn((line: string) => {
      lines.push(line)
      return true
    })
  }
  writeStreamDataEvents(socket, sessionId, data, maxLineBytes, rawLength, seq, transformed)
  return lines
}

// Preserve the pre-optimization writer as a byte-for-byte oracle.
function previousWrites(
  data: string,
  maxLineBytes: number,
  rawLength = data.length,
  seq?: number,
  transformed = false,
  sessionId = 'session-1'
): string[] {
  const explicitRawLength = rawLength === data.length ? undefined : rawLength
  if (transformed) {
    return [encodeStreamDataEvent(sessionId, data, rawLength, seq, true)]
  }
  const carriesMetadata = explicitRawLength !== undefined || seq !== undefined
  const chunks = splitStreamDataForNdjson(
    sessionId,
    data,
    carriesMetadata ? Math.max(1, maxLineBytes - 96) : maxLineBytes,
    explicitRawLength
  )
  let consumed = 0
  return chunks.map((chunk) => {
    consumed += chunk.length
    const chunkEndSeq = seq === undefined ? undefined : seq - (data.length - consumed)
    const chunkRawLength = explicitRawLength === 0 ? 0 : carriesMetadata ? chunk.length : undefined
    return encodeStreamDataEvent(sessionId, chunk, chunkRawLength, chunkEndSeq)
  })
}

beforeEach(() => {
  vi.mocked(encodeNdjson).mockClear()
})

describe('writeStreamDataEvents serialization budget', () => {
  it.each(['', 'x', '\x1b[2K\rredraw', '"\\\n\t\u0000', 'é中🐙', '\ud800x\udc00'])(
    'encodes an unsplit metadata-free frame once: %j',
    (data) => {
      const expected = previousWrites(data, 4096)
      expect(encodeNdjson).toHaveBeenCalledTimes(2)
      vi.mocked(encodeNdjson).mockClear()
      expect(write(data, 4096)).toEqual(expected)
      expect(encodeNdjson).toHaveBeenCalledTimes(1)
    }
  )

  it('reuses the encoded frame exactly at the inclusive byte cap', () => {
    const data = 'é🐙\x1b[0m'
    const line = encodeStreamDataEvent('session-1', data)
    vi.mocked(encodeNdjson).mockClear()
    expect(write(data, Buffer.byteLength(line))).toEqual([line])
    expect(encodeNdjson).toHaveBeenCalledTimes(1)
  })

  it('does not add a duplicate full-data sizing probe to oversized writes', () => {
    const data = '🐙\x1b[0m'.repeat(100)
    const expected = previousWrites(data, 160)
    const previousCount = vi.mocked(encodeNdjson).mock.calls.length
    vi.mocked(encodeNdjson).mockClear()
    expect(write(data, 160)).toEqual(expected)
    expect(encodeNdjson).toHaveBeenCalledTimes(previousCount)
  })

  it('keeps transformed writes at one encode without applying the ordinary byte cap', () => {
    const data = '🐙'.repeat(100)
    const lines = write(data, 1, 1234, 5000, true)
    expect(encodeNdjson).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([encodeStreamDataEvent('session-1', data, 1234, 5000, true)])
  })
})

describe('writeStreamDataEvents wire parity', () => {
  it('preserves exact frames, chunk boundaries and metadata across payloads and caps', () => {
    const payloads = [
      '',
      'x',
      'plain output\r\n'.repeat(24),
      '"\\\n\t\u0000'.repeat(40),
      'é中🐙'.repeat(40),
      '\ud800x\udc00🐙'.repeat(20)
    ]
    for (const sessionId of ['session-1', 'ssh/"中🐙']) {
      for (const data of payloads) {
        for (const maxLineBytes of [1, 96, 160, 256, 4096]) {
          for (const [rawLength, seq, transformed] of [
            [data.length, undefined, false],
            [data.length, 0, false],
            [data.length, 9000, false],
            [0, 9000, false],
            [7, undefined, false],
            [data.length + 99, 9000, false],
            [1234, 9000, true]
          ] as const) {
            const expected = previousWrites(
              data,
              maxLineBytes,
              rawLength,
              seq,
              transformed,
              sessionId
            )
            expect(write(data, maxLineBytes, rawLength, seq, transformed, sessionId)).toEqual(
              expected
            )
          }
        }
      }
    }
  })

  it('keeps JSON escaping, Unicode and newline framing byte-for-byte', () => {
    expect(write('"\\\n\t\u0000é中🐙', 4096)).toEqual([
      '{"type":"event","event":"data","sessionId":"session-1","payload":{"data":"\\\"\\\\\\n\\t\\u0000é中🐙"}}\n'
    ])
  })

  it('keeps split frames within the byte cap and preserves code points and sequence spans', () => {
    const data = '🐙é中\x1b[0m"\\\n'.repeat(100)
    for (const seq of [undefined, 9000]) {
      const lines = write(data, 256, data.length, seq)
      expect(lines.length).toBeGreaterThan(1)
      let consumed = 0
      const chunks = lines.map((line) => {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(256)
        expect(line.endsWith('\n')).toBe(true)
        const { payload } = JSON.parse(line)
        expect(payload.data).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/)
        consumed += payload.data.length
        if (seq !== undefined) {
          expect(payload.seq).toBe(seq - data.length + consumed)
          expect(payload.rawLength).toBe(payload.data.length)
          expect(payload.sequenceChars).toBe(payload.data.length)
        } else {
          expect(Object.keys(payload)).toEqual(['data'])
        }
        return payload.data as string
      })
      expect(chunks.join('')).toBe(data)
    }
  })
})
