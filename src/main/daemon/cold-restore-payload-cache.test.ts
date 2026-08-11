import { describe, expect, it } from 'vitest'
import {
  ColdRestorePayloadCache,
  getColdRestorePayloadBytes,
  type ColdRestorePayload
} from './cold-restore-payload-cache'

function payload(scrollback: string): ColdRestorePayload {
  return { scrollback, cwd: '/tmp', cols: 80, rows: 24 }
}

describe('ColdRestorePayloadCache', () => {
  it('counts retained strings by UTF-16 code units', () => {
    expect(
      getColdRestorePayloadBytes({
        ...payload('😀'),
        oscLinks: [{ row: 0, startCol: 0, endCol: 1, uri: 'é' }]
      })
    ).toBe(54)
  })

  it('evicts least-recently-used payloads to stay under its byte bound', () => {
    const first = payload('a'.repeat(100))
    const second = payload('b'.repeat(100))
    const third = payload('c'.repeat(100))
    const maxBytes = getColdRestorePayloadBytes(first) * 2
    const evicted: string[] = []
    const cache = new ColdRestorePayloadCache(maxBytes, (sessionId) => evicted.push(sessionId))

    cache.set('first', first)
    cache.set('second', second)
    expect(cache.get('first')).toBe(first)
    cache.set('third', third)

    expect(cache.has('first')).toBe(true)
    expect(cache.has('second')).toBe(false)
    expect(cache.has('third')).toBe(true)
    expect(cache.byteSize).toBeLessThanOrEqual(maxBytes)
    expect(evicted).toEqual(['second'])
  })

  it('does not retain one payload larger than the entire cache budget', () => {
    const cache = new ColdRestorePayloadCache(32)

    cache.set('oversized', payload('x'.repeat(100)))

    expect(cache.has('oversized')).toBe(false)
    expect(cache.byteSize).toBe(0)
  })
})
