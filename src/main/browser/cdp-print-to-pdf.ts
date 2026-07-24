import { randomUUID } from 'node:crypto'
import type { PrintToPDFOptions } from 'electron'

const PDF_DEFAULT_MARGIN_INCHES = 1 / 2.54
const PDF_STREAM_CHUNK_BYTES = 1024 * 1024
const PDF_STREAM_HANDLE_PREFIX = 'orca-pdf-'
const PDF_STREAM_TTL_MS = 5 * 60 * 1000
export const CDP_PDF_MAX_RETAINED_STREAMS = 8
export const CDP_PDF_MAX_RETAINED_BYTES = 64 * 1024 * 1024
export const CDP_PDF_MEMORY_LIMIT_ERROR = 'PDF exceeds the browser automation memory limit'

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
  releaseRetention: () => void
}

export type PdfStreamChunk = {
  data: string
  eof: boolean
}

export type CdpPdfStreamStoreOptions = {
  maxStreams?: number
  maxRetainedBytes?: number
  maxReadChunkBytes?: number
  retentionBudget?: CdpPdfRetentionBudget
}

export function assertCdpPdfWithinMemoryLimit(data: Buffer): void {
  if (data.length > CDP_PDF_MAX_RETAINED_BYTES) {
    throw new Error(CDP_PDF_MEMORY_LIMIT_ERROR)
  }
}

export class CdpPdfRetentionBudget {
  private retainedBytes = 0
  private retainedStreams = 0

  constructor(
    private readonly maxStreams = CDP_PDF_MAX_RETAINED_STREAMS,
    private readonly maxRetainedBytes = CDP_PDF_MAX_RETAINED_BYTES
  ) {}

  retain(bytes: number): (() => void) | null {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.retainedStreams >= this.maxStreams ||
      this.retainedBytes + bytes > this.maxRetainedBytes
    ) {
      return null
    }
    this.retainedStreams += 1
    this.retainedBytes += bytes
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.retainedStreams = Math.max(0, this.retainedStreams - 1)
      this.retainedBytes = Math.max(0, this.retainedBytes - bytes)
    }
  }

  inspect(): { retainedBytes: number; retainedStreams: number } {
    return { retainedBytes: this.retainedBytes, retainedStreams: this.retainedStreams }
  }
}

const processPdfRetentionBudget = new CdpPdfRetentionBudget()

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
  private readonly maxStreams: number
  private readonly maxRetainedBytes: number
  private readonly maxReadChunkBytes: number
  private readonly retentionBudget: CdpPdfRetentionBudget
  private nextId = 0
  private retainedBytes = 0

  constructor(options: CdpPdfStreamStoreOptions = {}) {
    this.maxStreams = Math.max(0, Math.floor(options.maxStreams ?? CDP_PDF_MAX_RETAINED_STREAMS))
    this.maxRetainedBytes = Math.max(
      0,
      Math.floor(options.maxRetainedBytes ?? CDP_PDF_MAX_RETAINED_BYTES)
    )
    this.maxReadChunkBytes = Math.max(
      1,
      Math.floor(options.maxReadChunkBytes ?? PDF_STREAM_CHUNK_BYTES)
    )
    this.retentionBudget = options.retentionBudget ?? processPdfRetentionBudget
  }

  /** True when `params.handle` names one of this store's streams. */
  ownsHandle(params: Record<string, unknown>): boolean {
    return typeof params.handle === 'string' && params.handle.startsWith(this.handlePrefix)
  }

  create(data: Buffer): string {
    if (
      data.length > this.maxRetainedBytes ||
      this.streams.size >= this.maxStreams ||
      this.retainedBytes + data.length > this.maxRetainedBytes
    ) {
      throw new Error(CDP_PDF_MEMORY_LIMIT_ERROR)
    }
    const releaseRetention = this.retentionBudget.retain(data.length)
    if (!releaseRetention) {
      throw new Error(CDP_PDF_MEMORY_LIMIT_ERROR)
    }
    const handle = `${this.handlePrefix}${++this.nextId}`
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null
    try {
      cleanupTimer = this.scheduleCleanup(handle)
      this.streams.set(handle, { data, offset: 0, cleanupTimer, releaseRetention })
    } catch (error) {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer)
      }
      releaseRetention()
      throw error
    }
    this.retainedBytes += data.length
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
        ? Math.min(Math.floor(requestedSize), this.maxReadChunkBytes)
        : this.maxReadChunkBytes
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
    for (const handle of this.streams.keys()) {
      this.delete(handle)
    }
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
    this.retainedBytes = Math.max(0, this.retainedBytes - stream.data.length)
    stream.releaseRetention()
  }
}
