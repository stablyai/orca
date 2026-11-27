import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  BrowserFileChooserAnswerResult,
  BrowserFileChooserRequest
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { acquireElectronDebugger } from '../../cdp/debugger/electron-debugger-lease'
import { sendGuestCdpCommand } from '../../cdp/debugger/guest-cdp-command'
import { assertUploadFilesExist } from '../../cdp/input/browser-upload-files'
import type { OpenedFileChooser } from '../../cdp/input/guest-file-chooser'
import { readRecord, readString } from '../../cdp/input/guest-frame-input-sessions'
import { withTimeout as rejectAfterTimeout } from '../../cdp/commands/cdp-screenshot'

// A hung page must not wedge the input queue on cleanup.
const PAGE_REPLY_TIMEOUT_MS = 2_000

/** A device streaming a server page that opens the page's file pickers on itself. */
export type BrowserFileChooserViewer = {
  pairedDeviceId: string
  ask: (request: BrowserFileChooserRequest) => void
}

type PendingChooser = {
  guest: WebContents
  pairedDeviceId: string
  backendNodeId: number
  sessionId: string | undefined
}

const viewersByGuestId = new Map<number, Map<string, BrowserFileChooserViewer>>()
const pendingChoosers = new Map<string, PendingChooser>()
const watchedGuests = new WeakSet<WebContents>()

export function addBrowserFileChooserViewer(
  guestWebContentsId: number,
  viewer: BrowserFileChooserViewer
): () => void {
  let viewers = viewersByGuestId.get(guestWebContentsId)
  if (!viewers) {
    viewers = new Map()
    viewersByGuestId.set(guestWebContentsId, viewers)
  }
  viewers.set(viewer.pairedDeviceId, viewer)
  return () => {
    if (viewers.get(viewer.pairedDeviceId) !== viewer) {
      return
    }
    viewers.delete(viewer.pairedDeviceId)
    if (viewers.size === 0 && viewersByGuestId.get(guestWebContentsId) === viewers) {
      viewersByGuestId.delete(guestWebContentsId)
    }
  }
}

/** The streaming device whose input this is, when it opens the page's pickers itself. */
export function browserFileChooserViewer(
  guestWebContentsId: number,
  pairedDeviceId: string | undefined
): BrowserFileChooserViewer | null {
  return pairedDeviceId === undefined
    ? null
    : (viewersByGuestId.get(guestWebContentsId)?.get(pairedDeviceId) ?? null)
}

/** Hands a picker the device's input opened to that device; the page waits for its files. */
export function askBrowserFileChooserViewer(
  guest: WebContents,
  viewer: BrowserFileChooserViewer,
  opened: OpenedFileChooser
): boolean {
  // The device may have left while its input ran.
  if (
    opened.backendNodeId === null ||
    browserFileChooserViewer(guest.id, viewer.pairedDeviceId) !== viewer
  ) {
    return false
  }
  // One open picker per device and page, as a person can only answer the newest one.
  for (const replaced of forgetPending(
    (pending) => pending.guest === guest && pending.pairedDeviceId === viewer.pairedDeviceId
  )) {
    void cancelHeldFileChooser(guest, replaced)
  }
  if (!watchedGuests.has(guest)) {
    watchedGuests.add(guest)
    guest.once('destroyed', () => forgetPending((pending) => pending.guest === guest))
  }
  const requestId = randomUUID()
  pendingChoosers.set(requestId, {
    guest,
    pairedDeviceId: viewer.pairedDeviceId,
    backendNodeId: opened.backendNodeId,
    sessionId: opened.sessionId
  })
  viewer.ask({ requestId, multiple: opened.multiple })
  return true
}

/** Null files: the person closed their picker. Paths are on this host, staged by the device. */
export async function answerBrowserFileChooser(
  pairedDeviceId: string | undefined,
  answer: { requestId: string; files: string[] | null }
): Promise<BrowserFileChooserAnswerResult> {
  const pending = pendingChoosers.get(answer.requestId)
  if (!pending || pending.pairedDeviceId !== pairedDeviceId) {
    return 'rejected'
  }
  pendingChoosers.delete(answer.requestId)
  const { guest, backendNodeId, sessionId } = pending
  if (guest.isDestroyed()) {
    return 'failed'
  }
  if (!answer.files || answer.files.length === 0) {
    return (await cancelHeldFileChooser(guest, pending)) ? 'answered' : 'failed'
  }
  try {
    await assertUploadFilesExist(answer.files)
  } catch (error) {
    await cancelHeldFileChooser(guest, pending)
    throw error
  }
  // A newer picker from this device replaced this one while the files were checked.
  if (
    [...pendingChoosers.values()].some(
      (other) => other.guest === guest && other.pairedDeviceId === pending.pairedDeviceId
    )
  ) {
    return 'rejected'
  }
  const lease = acquireElectronDebugger(guest)
  try {
    await sendGuestCdpCommand(
      guest,
      'DOM.setFileInputFiles',
      { files: answer.files, backendNodeId },
      sessionId
    )
    return 'answered'
  } catch {
    // The page navigated or removed its input while the person chose.
    return 'failed'
  } finally {
    lease.release()
  }
}

/** Tells the page its held picker closed, as Chromium does for a cancelled one; false when its input is gone. */
export async function cancelHeldFileChooser(
  guest: WebContents,
  { backendNodeId, sessionId }: { backendNodeId: number | null; sessionId: string | undefined }
): Promise<boolean> {
  if (backendNodeId === null || guest.isDestroyed()) {
    return false
  }
  const lease = acquireElectronDebugger(guest)
  // A page that never answers must not hold up the input cleaning up after it.
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    rejectAfterTimeout(
      sendGuestCdpCommand(guest, method, params, sessionId),
      PAGE_REPLY_TIMEOUT_MS,
      'The page did not answer.'
    )
  try {
    const resolved = await send('DOM.resolveNode', { backendNodeId })
    const objectId = readString(readRecord(resolved, 'object'), 'objectId')
    if (!objectId) {
      return false
    }
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function () { this.dispatchEvent(new Event('cancel', { bubbles: true })) }"
    })
    return true
  } catch {
    return false
  } finally {
    lease.release()
  }
}

function forgetPending(matches: (pending: PendingChooser) => boolean): PendingChooser[] {
  const forgotten: PendingChooser[] = []
  for (const [requestId, pending] of pendingChoosers) {
    if (matches(pending)) {
      pendingChoosers.delete(requestId)
      forgotten.push(pending)
    }
  }
  return forgotten
}
