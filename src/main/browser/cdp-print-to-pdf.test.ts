import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildPrintToPdfOptions, CdpPdfStreamStore } from './cdp-print-to-pdf'

const DEFAULT_MARGIN_INCHES = 1 / 2.54
const TTL_MS = 5 * 60 * 1000

describe('buildPrintToPdfOptions', () => {
  it('returns empty options for empty params', () => {
    expect(buildPrintToPdfOptions({})).toEqual({})
  })

  it('maps every well-formed field', () => {
    expect(
      buildPrintToPdfOptions({
        landscape: true,
        displayHeaderFooter: true,
        printBackground: true,
        preferCSSPageSize: true,
        generateTaggedPDF: true,
        generateDocumentOutline: false,
        scale: 1.5,
        paperWidth: 8.5,
        paperHeight: 11,
        marginTop: 0.25,
        marginBottom: 0.5,
        marginLeft: 0.75,
        marginRight: 1,
        pageRanges: '1-2',
        headerTemplate: '<span></span>',
        footerTemplate: '<span></span>'
      })
    ).toEqual({
      landscape: true,
      displayHeaderFooter: true,
      printBackground: true,
      preferCSSPageSize: true,
      generateTaggedPDF: true,
      generateDocumentOutline: false,
      scale: 1.5,
      pageSize: { width: 8.5, height: 11 },
      margins: { marginType: 'custom', top: 0.25, bottom: 0.5, left: 0.75, right: 1 },
      pageRanges: '1-2',
      headerTemplate: '<span></span>',
      footerTemplate: '<span></span>'
    })
  })

  it('defaults omitted margin sides to 1cm when any side is set', () => {
    expect(buildPrintToPdfOptions({ marginTop: 0.25 }).margins).toEqual({
      marginType: 'custom',
      top: 0.25,
      bottom: DEFAULT_MARGIN_INCHES,
      left: DEFAULT_MARGIN_INCHES,
      right: DEFAULT_MARGIN_INCHES
    })
  })

  it('drops non-finite and out-of-range numeric options', () => {
    const options = buildPrintToPdfOptions({
      scale: 0,
      paperWidth: Number.POSITIVE_INFINITY,
      paperHeight: 11,
      marginTop: Number.NaN
    })
    expect(options.scale).toBeUndefined()
    expect(options.pageSize).toBeUndefined()
    expect(options.margins).toBeUndefined()
  })

  it('requires both paper dimensions for pageSize', () => {
    expect(buildPrintToPdfOptions({ paperWidth: 8.5 }).pageSize).toBeUndefined()
  })

  it('ignores wrong-typed options', () => {
    expect(buildPrintToPdfOptions({ landscape: 'yes', pageRanges: 7 })).toEqual({})
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

  it('mints distinct handles per stream', () => {
    const store = new CdpPdfStreamStore()
    expect(store.create(Buffer.from('a'))).not.toBe(store.create(Buffer.from('b')))
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

  it('returns null for unknown handles', () => {
    const store = new CdpPdfStreamStore()
    expect(store.read({ handle: 'nope' })).toBeNull()
    expect(store.read({})).toBeNull()
  })

  it('drops a stream on close', () => {
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('abc'))

    store.close({ handle })
    expect(store.read({ handle })).toBeNull()
  })

  it('drops all streams on clear', () => {
    const store = new CdpPdfStreamStore()
    const handle = store.create(Buffer.from('abc'))

    store.clear()
    expect(store.read({ handle })).toBeNull()
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
