import { describe, expect, it } from 'vitest'
import type { BrowserScreencastPrintResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import {
  addBrowserPrintViewer,
  printForBrowserViewer,
  readBrowserPrintPdf,
  releaseBrowserPrintPdf
} from './browser-print-viewers'

describe('browser print viewers', () => {
  it('hands a print only to the device whose input printed, whole, one at a time', async () => {
    const pdf = Buffer.alloc(5 * 1024 * 1024 + 7)
    for (let i = 0; i < pdf.length; i += 1) {
      pdf[i] = (i * 31) % 251
    }
    const received: BrowserScreencastPrintResult[] = []
    const stop = addBrowserPrintViewer(7, {
      pairedDeviceId: 'desk-a',
      print: (event) => received.push(event)
    })
    let renders = 0
    const frame = {
      printToPDF: async () => {
        renders += 1
        return pdf
      }
    }

    expect(printForBrowserViewer(7, frame, 'desk-b', 'Invoice')).toBe(false)
    expect(printForBrowserViewer(7, frame, 'desk-a', 'Invoice')).toBe(true)
    // A page printing again while its first print waits renders nothing more.
    for (let i = 0; i < 50; i += 1) {
      printForBrowserViewer(7, frame, 'desk-a', 'Invoice')
    }
    await expect.poll(() => received.length).toBe(1)
    expect(renders).toBe(1)
    const { printId } = received[0]!

    expect(() => readBrowserPrintPdf('desk-b', { printId })).toThrow()
    expect(releaseBrowserPrintPdf('desk-b', { printId }).released).toBe(false)
    const slices: Buffer[] = []
    for (;;) {
      const read = readBrowserPrintPdf('desk-a', {
        printId,
        offset: slices.reduce((n, s) => n + s.length, 0)
      })
      slices.push(Buffer.from(read.contentBase64, 'base64'))
      if (read.eof) {
        break
      }
    }
    expect(slices.length).toBeGreaterThan(1)
    expect(Buffer.concat(slices).equals(pdf)).toBe(true)
    // The last slice releases it, and the page can print again.
    expect(() => readBrowserPrintPdf('desk-a', { printId })).toThrow()
    printForBrowserViewer(7, frame, 'desk-a', 'Invoice')
    await expect.poll(() => received.length).toBe(2)
    expect(releaseBrowserPrintPdf('desk-a', { printId: received[1]!.printId }).released).toBe(true)
    stop()
  })

  it('keeps a print that rendered between streams for the next stream of its tab', async () => {
    const received: BrowserScreencastPrintResult[] = []
    const stopOpener = addBrowserPrintViewer(20, { pairedDeviceId: 'desk-a', print: () => {} })
    let finishRender: (bytes: Buffer) => void = () => {}
    const frame = {
      printToPDF: () =>
        new Promise<Buffer>((resolve) => {
          finishRender = resolve
        })
    }
    // A popup (21) prints from the opener's click; the device streams only the opener (20).
    expect(printForBrowserViewer(21, frame, 'desk-a', 'Receipt', [20])).toBe(true)
    stopOpener()
    finishRender(Buffer.from('%PDF-receipt'))
    await Promise.resolve()
    const stopPopup = addBrowserPrintViewer(21, {
      pairedDeviceId: 'desk-a',
      print: (event) => received.push(event)
    })
    await expect.poll(() => received.length).toBe(1)
    const read = readBrowserPrintPdf('desk-a', { printId: received[0]!.printId })
    expect(Buffer.from(read.contentBase64, 'base64').toString()).toBe('%PDF-receipt')
    stopPopup()
  })
})
