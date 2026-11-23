import { randomUUID } from 'node:crypto'
import type { WebFrameMain } from 'electron'
import type {
  BrowserReadPrintPdfResult,
  BrowserScreencastPrintResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { BrowserError } from '../../browser-error'

// Base64 grows a slice by a third; this keeps each reply well under the 4 MiB frame cap.
const PRINT_READ_CHUNK_BYTES = 2 * 1024 * 1024
// Covers a person choosing where to save; each read restarts it.
const PRINT_HOLD_MS = 5 * 60_000
const MAX_WAITING_PRINTS = 3

/** A device streaming a server page that saves what its own input makes the page print. */
export type BrowserPrintViewer = {
  pairedDeviceId: string
  print: (event: BrowserScreencastPrintResult) => void
}

type HeldPrint = {
  pairedDeviceId: string
  guestWebContentsId: number
  bytes: Buffer
  expiry: NodeJS.Timeout
}

const viewersByGuestId = new Map<number, Set<BrowserPrintViewer>>()
const heldPrints = new Map<string, HeldPrint>()

export function addBrowserPrintViewer(
  guestWebContentsId: number,
  viewer: BrowserPrintViewer
): () => void {
  let viewers = viewersByGuestId.get(guestWebContentsId)
  if (!viewers) {
    viewers = new Set()
    viewersByGuestId.set(guestWebContentsId, viewers)
  }
  viewers.add(viewer)
  return () => {
    viewers.delete(viewer)
    if (viewers.size === 0 && viewersByGuestId.get(guestWebContentsId) === viewers) {
      viewersByGuestId.delete(guestWebContentsId)
    }
  }
}

/**
 * Prints the frame to PDF now, before the page changes or closes, and hands it to the device's
 * streams of the page. False when that device isn't streaming the page with `prints: 1`.
 */
export function printForBrowserViewer(
  guestWebContentsId: number,
  frame: Pick<WebFrameMain, 'printToPDF'>,
  pairedDeviceId: string,
  title: string
): boolean {
  const viewers = (): BrowserPrintViewer[] =>
    [...(viewersByGuestId.get(guestWebContentsId) ?? [])].filter(
      (viewer) => viewer.pairedDeviceId === pairedDeviceId
    )
  if (viewers().length === 0) {
    return false
  }
  void frame
    .printToPDF({ printBackground: true, preferCSSPageSize: true })
    .then((bytes) => {
      // The device may have stopped streaming the page while it rendered.
      const current = viewers()
      if (current.length === 0) {
        return
      }
      // A save in progress keeps its print; the oldest beyond a few is dropped to bound memory.
      const waiting = [...heldPrints].filter(
        ([, held]) =>
          held.guestWebContentsId === guestWebContentsId && held.pairedDeviceId === pairedDeviceId
      )
      for (const [printId] of waiting.slice(
        0,
        Math.max(0, waiting.length - MAX_WAITING_PRINTS + 1)
      )) {
        forgetHeldPrint(printId)
      }
      const printId = randomUUID()
      heldPrints.set(printId, {
        pairedDeviceId,
        guestWebContentsId,
        bytes,
        expiry: expireHeldPrint(printId)
      })
      for (const viewer of current) {
        viewer.print({ type: 'print', printId, title })
      }
    })
    .catch((error: unknown) => {
      console.warn('[browser] Could not print a server page for its viewer', error)
    })
  return true
}

/** A slice of a print handed to this device; the last slice releases it. */
export function readBrowserPrintPdf(
  pairedDeviceId: string | undefined,
  params: { printId: string; offset?: number }
): BrowserReadPrintPdfResult {
  const held = heldPrints.get(params.printId)
  if (!held || held.pairedDeviceId !== pairedDeviceId) {
    throw new BrowserError('browser_error', 'This print is no longer available. Print again.')
  }
  const start = Math.min(Math.max(0, Math.floor(params.offset ?? 0)), held.bytes.length)
  const chunk = held.bytes.subarray(start, start + PRINT_READ_CHUNK_BYTES)
  const eof = start + chunk.length >= held.bytes.length
  if (eof) {
    forgetHeldPrint(params.printId)
  } else {
    clearTimeout(held.expiry)
    held.expiry = expireHeldPrint(params.printId)
  }
  return { contentBase64: chunk.toString('base64'), bytesRead: chunk.length, eof }
}

function expireHeldPrint(printId: string): NodeJS.Timeout {
  return setTimeout(() => heldPrints.delete(printId), PRINT_HOLD_MS).unref()
}

function forgetHeldPrint(printId: string): void {
  const held = heldPrints.get(printId)
  if (held) {
    clearTimeout(held.expiry)
    heldPrints.delete(printId)
  }
}
