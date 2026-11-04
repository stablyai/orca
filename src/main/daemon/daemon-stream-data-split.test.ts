import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { writeStreamDataEvents } from './daemon-stream-data-split'

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

describe('writeStreamDataEvents wire parity', () => {
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
