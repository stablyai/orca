import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildPrintToPdfOptions, CdpPdfStreamStore } from './cdp-print-to-pdf'

const DEFAULT_MARGIN_INCHES = 1 / 2.54
const TTL_MS = 5 * 60 * 1000

describe('buildPrintToPdfOptions', () => {
  it('defaults omitted margin sides to 1cm when any side is set', () => {
    expect(buildPrintToPdfOptions({ marginTop: 0.25 }).margins).toEqual({
      top: 0.25,
      bottom: DEFAULT_MARGIN_INCHES,
      left: DEFAULT_MARGIN_INCHES,
      right: DEFAULT_MARGIN_INCHES
    })
  })
})

describe('CdpPdfStreamStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('claims only its own handles', () => {
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('pdf'))

    expect(store.ownsHandle({ handle })).toBe(true)
    expect(handle).toMatch(/^orca-pdf-[\da-f-]{36}-\d+$/)
    expect(store.ownsHandle({ handle: 'trace-stream' })).toBe(false)
    expect(store.ownsHandle({ handle: 'orca-pdf-forged-1' })).toBe(false)
    expect(store.ownsHandle({})).toBe(false)
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

  it('honors an explicit read offset', () => {
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('abcdef'))

    expect(store.read({ handle, offset: 4 })).toEqual({
      data: Buffer.from('ef').toString('base64'),
      eof: true
    })
  })

  it('returns an empty eof chunk when reading past the end', () => {
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('abc'))

    expect(store.read({ handle, offset: 99 })).toEqual({ data: '', eof: true })
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
