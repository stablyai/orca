import type { WebContents } from 'electron'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { BrowserError } from '../../browser-error'
import { acquireElectronDebugger } from '../debugger/electron-debugger-lease'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'
import { withTimeout as rejectAfterTimeout } from '../commands/cdp-screenshot'
import { runOutsideRemoteCliBrowserScope } from '../../../runtime/desktop-browser-bridge/remote-cli-browser-scope'

// A click's user activation lasts 5s in Chromium, so its picker cannot open any later.
const FILE_CHOOSER_OPEN_TIMEOUT_MS = 5_000
// A hung page must not wedge its command queue on setup or cleanup.
const PAGE_REPLY_TIMEOUT_MS = 2_000

export type OpenedFileChooser = { backendNodeId: number | null; sessionId: string | undefined }

export type FileChooserInterception = {
  /** The next chooser the page opened, or null when none opened in time. */
  next(): Promise<OpenedFileChooser | null>
  /** Whether a chooser has opened since interception began. */
  readonly opened: boolean
  release(): Promise<void>
}

/**
 * Catches file choosers opened from a frame's CDP session, or from the page's (a click activates
 * ancestor frames too), instead of showing the OS dialog.
 */
export async function interceptFileChooser(
  wc: WebContents,
  frameSessionId: string | undefined,
  // Cancel tells the page its picker closed; upload keeps it pending to set files.
  { cancel = false }: { cancel?: boolean } = {}
): Promise<FileChooserInterception> {
  const sessionIds = [...new Set([undefined, frameSessionId])]
  const { promise: opened, resolve: resolveOpened } = Promise.withResolvers<OpenedFileChooser>()
  let openedAny = false
  const onMessage = (
    _event: unknown,
    method: string,
    params: { backendNodeId?: number } | undefined,
    eventSessionId?: string
  ): void => {
    const sessionId = eventSessionId || undefined
    if (method === 'Page.fileChooserOpened' && sessionIds.includes(sessionId)) {
      openedAny = true
      resolveOpened({ backendNodeId: params?.backendNodeId ?? null, sessionId })
    }
  }
  // The getter throws once the guest is destroyed, e.g. after a click that closes its popup.
  const dbg = wc.debugger
  dbg.on('message', onMessage)
  const release = async (): Promise<void> => {
    dbg.removeListener('message', onMessage)
    if (wc.isDestroyed()) {
      return
    }
    // Desktop-owned cleanup: a revoked host scope must not leave the user's pickers intercepted.
    await runOutsideRemoteCliBrowserScope(() =>
      Promise.all(
        sessionIds.map((sessionId) =>
          // Best-effort: a page that never answers keeps its queue moving.
          withTimeout(
            sendGuestCdpCommand(
              wc,
              'Page.setInterceptFileChooserDialog',
              { enabled: false },
              sessionId
            ),
            PAGE_REPLY_TIMEOUT_MS,
            undefined
          )
        )
      )
    )
  }
  try {
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        // Chromium reports choosers only with Page on; a page with no agent session may not have it.
        await rejectAfterTimeout(
          sendGuestCdpCommand(wc, 'Page.enable', {}, sessionId),
          PAGE_REPLY_TIMEOUT_MS,
          'The page is not responding, so Orca did not send the input.'
        )
        await sendGuestCdpCommand(
          wc,
          'Page.setInterceptFileChooserDialog',
          cancel ? { enabled: true, cancel: true } : { enabled: true },
          sessionId
        )
      })
    )
  } catch (error) {
    await release()
    throw error
  }
  return {
    next: () => withTimeout<OpenedFileChooser | null>(opened, FILE_CHOOSER_OPEN_TIMEOUT_MS, null),
    get opened() {
      return openedAny
    },
    release
  }
}

/** Agent or remote input must not raise the OS file dialog, which activates Orca over the user's work. */
export async function withFileChooserBlocked<T>(
  wc: WebContents,
  run: () => Promise<T>,
  { agent }: { agent: boolean }
): Promise<T> {
  const debuggerLease = acquireElectronDebugger(wc)
  try {
    const chooser = await interceptFileChooser(wc, undefined, { cancel: true })
    let result: T
    try {
      result = await run()
    } finally {
      await chooser.release()
    }
    if (chooser.opened) {
      throw new BrowserError(
        'browser_file_chooser_opened',
        agent
          ? 'The action opened a file picker, which Orca closed so the system dialog would not take over the screen. To choose files, run `upload --element <ref> --files <paths>` on the file input or the button that opens it.'
          : "This page's file picker can't open from a remote view."
      )
    }
    return result
  } finally {
    debuggerLease.release()
  }
}
