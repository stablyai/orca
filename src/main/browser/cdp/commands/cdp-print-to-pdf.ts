import { randomUUID } from 'node:crypto'
import type { PrintToPDFOptions } from 'electron'

const PDF_DEFAULT_MARGIN_INCHES = 1 / 2.54
const PDF_STREAM_CHUNK_BYTES = 1024 * 1024
const PDF_STREAM_HANDLE_PREFIX = 'orca-pdf-'
const PDF_STREAM_TTL_MS = 5 * 60 * 1000

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

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
    // Both APIs use inches; CDP defaults omitted sides to 1 cm. Explicit sides imply custom margins.
    options.margins = {
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

export class CdpPdfStreamStore {
  private readonly streams = new Map<string, PdfStream>()
  // Random prefixes avoid collisions with Chromium streams and other store instances.
  private readonly handlePrefix = `${PDF_STREAM_HANDLE_PREFIX}${randomUUID()}-`
  private nextId = 0

  /** Recognizes this store’s handle prefix, including expired handles. */
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

  /** Returns null for unknown or expired handles. */
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
    // Expire abandoned streams without requiring a client close.
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
