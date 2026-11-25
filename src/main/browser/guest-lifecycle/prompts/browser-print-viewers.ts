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
// A PDF past this is not held for a viewer: memory, and minutes over a slow link.
const PRINT_MAX_BYTES = 256 * 1024 * 1024

/** A device streaming a server page that saves what its own input makes the page print. */
export type BrowserPrintViewer = {
  pairedDeviceId: string
  print: (event: BrowserScreencastPrintResult) => void
}

/**
 * One print per device and page, from rendering until it is read to the end, released or expires.
 * It outlives the stream it was sent on: the save dialog may stay open across a reconnect.
 */
type PrintSlot = {
  pairedDeviceId: string
  guestWebContentsId: number
  // The pages whose streams may take it: the printing page first, then the rest of its tab.
  receivers: readonly number[]
  title: string
  // Null while the PDF renders.
  bytes: Buffer | null
  // The device has read from it. Until then each new stream of a receiver page is told again,
  // as the stream that was told may have been closing (the device moving to a just-opened popup).
  read: boolean
  expiry: NodeJS.Timeout
}

const viewersByGuestId = new Map<number, Set<BrowserPrintViewer>>()
const slots = new Map<string, PrintSlot>()

function deviceViewers(guestWebContentsId: number, pairedDeviceId: string): BrowserPrintViewer[] {
  return [...(viewersByGuestId.get(guestWebContentsId) ?? [])].filter(
    (viewer) => viewer.pairedDeviceId === pairedDeviceId
  )
}

function slotsOf(guestWebContentsId: number, pairedDeviceId: string): [string, PrintSlot][] {
  return [...slots].filter(
    ([, slot]) =>
      slot.guestWebContentsId === guestWebContentsId && slot.pairedDeviceId === pairedDeviceId
  )
}

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
  for (const [printId, slot] of slots) {
    if (
      !slot.read &&
      slot.bytes &&
      slot.pairedDeviceId === viewer.pairedDeviceId &&
      slot.receivers.includes(guestWebContentsId)
    ) {
      deliverPrint(printId, slot, viewer)
    }
  }
  return () => {
    viewers.delete(viewer)
    if (viewers.size === 0 && viewersByGuestId.get(guestWebContentsId) === viewers) {
      viewersByGuestId.delete(guestWebContentsId)
    }
  }
}

/**
 * Prints the frame to PDF now, before the page changes or closes, and hands it to one of the
 * device's streams of the page, or of another page in its tab (a popup prints before the device
 * streams it). While an earlier print of the page waits for that device (its save dialog is
 * open), a new one is dropped, as a print dialog blocks the page locally. False when that device
 * streams none of those pages with `prints: 1`.
 */
export function printForBrowserViewer(
  guestWebContentsId: number,
  frame: Pick<WebFrameMain, 'printToPDF'>,
  pairedDeviceId: string,
  title: string,
  tabGuestWebContentsIds: readonly number[] = []
): boolean {
  const receivers = [guestWebContentsId, ...tabGuestWebContentsIds]
  // One stream reads it, as its last slice releases it; the printing page's own stream first.
  const receiver = (): BrowserPrintViewer | undefined =>
    receivers
      .map((guestId) => deviceViewers(guestId, pairedDeviceId).at(-1))
      .find((viewer) => viewer !== undefined)
  if (!receiver()) {
    return false
  }
  if (slotsOf(guestWebContentsId, pairedDeviceId).length > 0) {
    return true
  }
  const printId = randomUUID()
  const slot: PrintSlot = {
    pairedDeviceId,
    guestWebContentsId,
    receivers,
    title,
    bytes: null,
    read: false,
    expiry: expirePrint(printId)
  }
  slots.set(printId, slot)
  void frame
    .printToPDF({ printBackground: true, preferCSSPageSize: true })
    .then((bytes) => {
      if (slots.get(printId) !== slot) {
        return
      }
      if (bytes.length > PRINT_MAX_BYTES) {
        forgetPrint(printId)
        return
      }
      slot.bytes = bytes
      const viewer = receiver()
      if (viewer) {
        deliverPrint(printId, slot, viewer)
      }
    })
    .catch((error: unknown) => {
      forgetPrint(printId)
      console.warn('[browser] Could not print a server page for its viewer', error)
    })
  return true
}

/** A slice of a print handed to this device; the last slice releases it. */
export function readBrowserPrintPdf(
  pairedDeviceId: string | undefined,
  params: { printId: string; offset?: number }
): BrowserReadPrintPdfResult {
  const slot = slots.get(params.printId)
  const bytes = slot && slot.pairedDeviceId === pairedDeviceId ? slot.bytes : null
  if (!slot || !bytes) {
    throw new BrowserError('browser_error', 'This print is no longer available. Print again.')
  }
  slot.read = true
  const start = Math.min(Math.max(0, Math.floor(params.offset ?? 0)), bytes.length)
  const chunk = bytes.subarray(start, start + PRINT_READ_CHUNK_BYTES)
  const eof = start + chunk.length >= bytes.length
  if (eof) {
    forgetPrint(params.printId)
  } else {
    clearTimeout(slot.expiry)
    slot.expiry = expirePrint(params.printId)
  }
  return { contentBase64: chunk.toString('base64'), bytesRead: chunk.length, eof }
}

/** The device won't read it (its save was cancelled or failed), so the page may print again. */
export function releaseBrowserPrintPdf(
  pairedDeviceId: string | undefined,
  params: { printId: string }
): { released: boolean } {
  if (slots.get(params.printId)?.pairedDeviceId !== pairedDeviceId) {
    return { released: false }
  }
  forgetPrint(params.printId)
  return { released: true }
}

function deliverPrint(printId: string, slot: PrintSlot, viewer: BrowserPrintViewer): void {
  viewer.print({ type: 'print', printId, title: slot.title })
}

function expirePrint(printId: string): NodeJS.Timeout {
  return setTimeout(() => slots.delete(printId), PRINT_HOLD_MS).unref()
}

function forgetPrint(printId: string): void {
  const slot = slots.get(printId)
  if (slot) {
    clearTimeout(slot.expiry)
    slots.delete(printId)
  }
}
