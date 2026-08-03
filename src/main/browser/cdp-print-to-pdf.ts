import { randomUUID } from 'node:crypto'
import type { PrintToPDFOptions } from 'electron'

const PDF_DEFAULT_MARGIN_INCHES = 1 / 2.54
const PDF_STREAM_CHUNK_BYTES = 1024 * 1024
const PDF_STREAM_HANDLE_PREFIX = 'orca-pdf-'
const PDF_STREAM_TTL_MS = 5 * 60 * 1000

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Translate CDP `Page.printToPDF` params into Electron `printToPDF` options.
 * Only well-formed values are forwarded so a malformed param can never smuggle
 * NaN/Infinity into Electron; omitted margin sides default to CDP's 1cm.
 */
export function buildPrintToPdfOptions(params: Record<string, unknown>): PrintToPDFOptions {
  const options: PrintToPDFOptions = {}

  if (typeof params.landscape === 'boolean') {
    options.landscape = params.landscape
  }
  if (typeof params.displayHeaderFooter === 'boolean') {
    options.displayHeaderFooter = params.displayHeaderFooter
  }
  if (typeof params.printBackground === 'boolean') {
    options.printBackground = params.printBackground
  }
  if (typeof params.preferCSSPageSize === 'boolean') {
    options.preferCSSPageSize = params.preferCSSPageSize
  }
  if (typeof params.generateTaggedPDF === 'boolean') {
    options.generateTaggedPDF = params.generateTaggedPDF
  }
  if (typeof params.generateDocumentOutline === 'boolean') {
    options.generateDocumentOutline = params.generateDocumentOutline
  }

  const scale = finiteNumber(params.scale)
  if (scale !== null && scale > 0) {
    options.scale = scale
  }

  const paperWidth = finiteNumber(params.paperWidth)
  const paperHeight = finiteNumber(params.paperHeight)
  if (paperWidth !== null && paperHeight !== null && paperWidth > 0 && paperHeight > 0) {
    options.pageSize = { width: paperWidth, height: paperHeight }
  }

  const marginTop = finiteNumber(params.marginTop)
  const marginBottom = finiteNumber(params.marginBottom)
  const marginLeft = finiteNumber(params.marginLeft)
  const marginRight = finiteNumber(params.marginRight)
  if ([marginTop, marginBottom, marginLeft, marginRight].some((margin) => margin !== null)) {
    // CDP and Electron printToPDF both use inches; omitted CDP sides default to 1cm.
    options.margins = {
      marginType: 'custom',
      top: marginTop ?? PDF_DEFAULT_MARGIN_INCHES,
      bottom: marginBottom ?? PDF_DEFAULT_MARGIN_INCHES,
      left: marginLeft ?? PDF_DEFAULT_MARGIN_INCHES,
      right: marginRight ?? PDF_DEFAULT_MARGIN_INCHES
    }
  }

  if (typeof params.pageRanges === 'string') {
    options.pageRanges = params.pageRanges
  }
  if (typeof params.headerTemplate === 'string') {
    options.headerTemplate = params.headerTemplate
  }
  if (typeof params.footerTemplate === 'string') {
    options.footerTemplate = params.footerTemplate
  }

  return options
}

type PdfStream = {
  data: Buffer
  offset: number
  cleanupTimer: ReturnType<typeof setTimeout>
}

export type PdfStreamChunk = {
  data: string
  eof: boolean
}

/**
 * Holds the PDF buffers produced for CDP `transferMode: "ReturnAsStream"` and
 * serves them back through `IO.read` / `IO.close`, the path Playwright's
 * `page.pdf()` uses. Handles carry a per-instance random prefix so a CDP client
 * cannot forge one or collide with a real Chromium IO stream, and each buffer is
 * evicted after a TTL so an abandoned stream can never leak memory.
 */
export class CdpPdfStreamStore {
  private readonly streams = new Map<string, PdfStream>()
  private readonly handlePrefix = `${PDF_STREAM_HANDLE_PREFIX}${randomUUID()}-`
  private nextId = 0

  /** True when `params.handle` names one of this store's streams. */
  ownsHandle(params: Record<string, unknown>): boolean {
    return typeof params.handle === 'string' && params.handle.startsWith(this.handlePrefix)
  }

  create(data: Buffer): string {
    const handle = `${this.handlePrefix}${++this.nextId}`
    this.streams.set(handle, {
      data,
      offset: 0,
      cleanupTimer: this.scheduleCleanup(handle)
    })
    return handle
  }

  /** Read the next chunk, or `null` if the handle is unknown/expired. */
  read(params: Record<string, unknown>): PdfStreamChunk | null {
    const handle = typeof params.handle === 'string' ? params.handle : ''
    const stream = this.streams.get(handle)
    if (!stream) {
      return null
    }
    this.refreshCleanup(handle, stream)

    const offset = finiteNumber(params.offset)
    if (offset !== null) {
      stream.offset = Math.max(0, Math.floor(offset))
    }
    const requestedSize = finiteNumber(params.size)
    const size =
      requestedSize !== null && requestedSize > 0
        ? Math.floor(requestedSize)
        : PDF_STREAM_CHUNK_BYTES
    const start = Math.min(stream.offset, stream.data.length)
    const end = Math.min(start + size, stream.data.length)
    const chunk = stream.data.subarray(start, end)
    stream.offset = end

    return { data: chunk.toString('base64'), eof: end >= stream.data.length }
  }

  close(params: Record<string, unknown>): void {
    const handle = typeof params.handle === 'string' ? params.handle : ''
    this.delete(handle)
  }

  clear(): void {
    for (const stream of this.streams.values()) {
      clearTimeout(stream.cleanupTimer)
    }
    this.streams.clear()
  }

  private scheduleCleanup(handle: string): ReturnType<typeof setTimeout> {
    const cleanupTimer = setTimeout(() => {
      this.delete(handle)
    }, PDF_STREAM_TTL_MS)
    const maybeNodeTimer = cleanupTimer as { unref?: () => void }
    maybeNodeTimer.unref?.()
    return cleanupTimer
  }

  private refreshCleanup(handle: string, stream: PdfStream): void {
    clearTimeout(stream.cleanupTimer)
    stream.cleanupTimer = this.scheduleCleanup(handle)
  }

  private delete(handle: string): void {
    const stream = this.streams.get(handle)
    if (!stream) {
      return
    }
    clearTimeout(stream.cleanupTimer)
    this.streams.delete(handle)
  }
}
