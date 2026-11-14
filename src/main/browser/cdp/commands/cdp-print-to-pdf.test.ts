import { describe, it, expect, vi, afterEach } from 'vitest'
import { CdpPdfStreamStore } from './cdp-print-to-pdf'
const TTL_MS = 5 * 60 * 1000

describe('CdpPdfStreamStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads sequential chunks and reports eof', () => {
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('abcdef'))

    expect(store.read({ handle, size: 2 })).toEqual({
      data: Buffer.from('ab').toString('base64'),
      eof: false
    })
    expect(store.read({ handle })).toEqual({
      data: Buffer.from('cdef').toString('base64'),
      eof: true
    })
  })

  it('evicts an abandoned stream after the TTL', () => {
    vi.useFakeTimers()
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('abc'))

    vi.advanceTimersByTime(TTL_MS + 1)
    expect(store.read({ handle })).toBeNull()
  })

  it('refreshes the TTL on each read', () => {
    vi.useFakeTimers()
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('abcdef'))

    vi.advanceTimersByTime(TTL_MS - 1)
    expect(store.read({ handle, size: 1 })).not.toBeNull()
    vi.advanceTimersByTime(TTL_MS - 1)
    expect(store.read({ handle, size: 1 })).not.toBeNull()
  })
})
