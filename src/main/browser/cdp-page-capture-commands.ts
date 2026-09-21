import type { WebSocket } from 'ws'
import type { WebContents } from 'electron'
import { captureScreenshot } from './cdp-screenshot'
import { buildPrintToPdfOptions, CdpPdfStreamStore } from './cdp-print-to-pdf'
import type { CdpClientResponseWriter } from './cdp-client-response-writer'

/**
 * Page capture output: Electron-native Page.printToPDF (inline and ReturnAsStream),
 * the IO.read/IO.close handlers serving those PDF handles, and Page.captureScreenshot.
 */
export class CdpPageCaptureCommands {
  private readonly pdfStreams = new CdpPdfStreamStore()

  constructor(
    private readonly webContents: WebContents,
    private readonly responder: CdpClientResponseWriter
  ) {}

  clear(): void {
    this.pdfStreams.clear()
  }

  ownsHandle(params: Record<string, unknown>): boolean {
    return this.pdfStreams.ownsHandle(params)
  }

  async handlePrintToPdf(
    client: WebSocket,
    clientId: number,
    params: Record<string, unknown>
  ): Promise<void> {
    if (this.webContents.isDestroyed()) {
      this.responder.sendError(clientId, 'Browser tab is no longer available', client)
      return
    }
    try {
      const pdf = await this.webContents.printToPDF(buildPrintToPdfOptions(params))
      // Why: printToPDF can resolve after the client disconnected (or was
      // replaced). Bail before registering a stream so its buffer isn't
      // orphaned in pdfStreams past the disconnect's clear() until the TTL.
      if (!this.responder.isActiveClient(client)) {
        return
      }
      const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf)
      if (params.transferMode === 'ReturnAsStream') {
        const handle = this.pdfStreams.create(buffer)
        this.responder.sendResult(clientId, { data: '', stream: handle }, client)
        return
      }
      this.responder.sendResult(clientId, { data: buffer.toString('base64') }, client)
    } catch (err) {
      this.responder.sendError(clientId, err instanceof Error ? err.message : String(err), client)
    }
  }

  handleStreamRead(client: WebSocket, clientId: number, params: Record<string, unknown>): void {
    const chunk = this.pdfStreams.read(params)
    if (!chunk) {
      this.responder.sendError(clientId, 'Invalid stream handle', client)
      return
    }
    this.responder.sendResult(
      clientId,
      { base64Encoded: true, data: chunk.data, eof: chunk.eof },
      client
    )
  }

  handleStreamClose(client: WebSocket, clientId: number, params: Record<string, unknown>): void {
    this.pdfStreams.close(params)
    this.responder.sendResult(clientId, {}, client)
  }

  handleScreenshot(client: WebSocket, clientId: number, params?: Record<string, unknown>): void {
    captureScreenshot(
      this.webContents,
      params,
      (result) => this.responder.sendResult(clientId, result, client),
      (message) => this.responder.sendError(clientId, message, client)
    )
  }
}
