import type { WebContents } from 'electron'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { BrowserError } from '../../browser-error'
import { acquireElectronDebugger } from '../debugger/electron-debugger-lease'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'

// A click's user activation lasts 5s in Chromium, so its picker cannot open any later.
const FILE_CHOOSER_OPEN_TIMEOUT_MS = 5_000

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
  frameSessionId: string | undefined
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
  wc.debugger.on('message', onMessage)
  const release = async (): Promise<void> => {
    wc.debugger.removeListener('message', onMessage)
    await Promise.all(
      sessionIds.map((sessionId) =>
        sendGuestCdpCommand(
          wc,
          'Page.setInterceptFileChooserDialog',
          { enabled: false },
          sessionId
        ).catch(() => {})
      )
    )
  }
  try {
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        // Cross-site frame sessions report choosers only with Page on; the page session has it.
        if (sessionId !== undefined) {
          await sendGuestCdpCommand(wc, 'Page.enable', {}, sessionId)
        }
        await sendGuestCdpCommand(
          wc,
          'Page.setInterceptFileChooserDialog',
          { enabled: true },
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

/** Agent input must not raise the OS file dialog, which activates Orca over the user's work. */
export async function withFileChooserBlocked<T>(
  wc: WebContents,
  run: () => Promise<T>
): Promise<T> {
  const debuggerLease = acquireElectronDebugger(wc)
  try {
    const chooser = await interceptFileChooser(wc, undefined)
    let result: T
    try {
      result = await run()
    } finally {
      await chooser.release()
    }
    if (chooser.opened) {
      throw new BrowserError(
        'browser_file_chooser_opened',
        'The action opened a file picker, which Orca closed so the system dialog would not take over the screen. To choose files, run `upload --element <ref> --files <paths>` on the file input or the button that opens it.'
      )
    }
    return result
  } finally {
    debuggerLease.release()
  }
}
