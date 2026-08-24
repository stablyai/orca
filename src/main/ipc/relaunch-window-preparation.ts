import { BrowserWindow, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import {
  APP_RELAUNCH_PREPARE_ABORT_CHANNEL,
  APP_RELAUNCH_PREPARE_CHANNEL,
  APP_RELAUNCH_PREPARE_REPLY_CHANNEL,
  type AppRelaunchPrepareReply
} from '../../shared/relaunch-preparation-ipc'
import { isRendererPreloadWindow } from '../window/renderer-preload-window-registry'

// Why: a hung renderer can never confirm a backup; a bounded wait keeps one
// unresponsive window from pinning every future relaunch open.
export const RELAUNCH_PREPARE_REPLY_TIMEOUT_MS = 5_000

let nextRelaunchPrepareRequestId = 1

type PrepareOutcome = 'prepared' | 'refused' | 'unresponsive'

/**
 * The invoking preload preps only its own document before app:relaunch, and
 * app.exit(0) skips unload — so every other window (e.g. the main window when
 * a dashboard popout initiates the restart) would lose dirty editor buffers.
 * Ask each of them to run the same restart preparation and wait for a verdict.
 *
 * An explicit refusal (checkpoint could not persist) throws so the relaunch is
 * abandoned with the app still open. Silence (no preload handler, hung
 * renderer) degrades after the timeout to the unprepared pre-handshake
 * behavior for that window only, rather than blocking recovery forever.
 */
// Why isRendererPreloadWindow: preload-less windows (offscreen browser backend,
// html-to-pdf, cookie-clear) can never answer the handshake; asking them would
// stall every relaunch into the 5s unresponsive degrade and exit unprepared.
function relaunchPreparationTargets(sender?: WebContents | null): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) =>
      !win.isDestroyed() &&
      !win.webContents.isDestroyed() &&
      isRendererPreloadWindow(win.webContents) &&
      (!sender || win.webContents.id !== sender.id)
  )
}

/** Releases the restart latch + shutdown-checkpoint guard armed by an abandoned prepared round. */
export function broadcastRelaunchPrepareAbort(sender?: WebContents | null): void {
  for (const win of relaunchPreparationTargets(sender)) {
    try {
      win.webContents.send(APP_RELAUNCH_PREPARE_ABORT_CHANNEL)
    } catch {
      // Why: one torn-down window must not keep the abort from the rest.
    }
  }
}

export async function prepareOtherWindowsForRelaunch(
  sender: WebContents | null | undefined
): Promise<void> {
  const targets = relaunchPreparationTargets(sender)
  if (targets.length === 0) {
    return
  }
  const requestId = nextRelaunchPrepareRequestId++
  const resolvers = new Map<number, (outcome: PrepareOutcome) => void>()
  const onReply = (event: IpcMainEvent, reply: AppRelaunchPrepareReply): void => {
    if (reply?.requestId !== requestId) {
      return
    }
    resolvers.get(event.sender.id)?.(reply.ok === true ? 'prepared' : 'refused')
  }
  ipcMain.on(APP_RELAUNCH_PREPARE_REPLY_CHANNEL, onReply)
  try {
    const outcomes = await Promise.all(
      targets.map(
        (win) =>
          new Promise<PrepareOutcome>((resolve) => {
            const timer = setTimeout(
              () => resolve('unresponsive'),
              RELAUNCH_PREPARE_REPLY_TIMEOUT_MS
            )
            resolvers.set(win.webContents.id, (outcome) => {
              clearTimeout(timer)
              resolve(outcome)
            })
            win.webContents.send(APP_RELAUNCH_PREPARE_CHANNEL, { requestId })
          })
      )
    )
    if (outcomes.includes('refused')) {
      throw new Error('A window refused its pre-relaunch checkpoint; keeping the app open.')
    }
  } catch (error) {
    // Why: windows that already prepared armed their restart latch; any throw
    // out of this round (refusal or otherwise) abandons it, so release them.
    broadcastRelaunchPrepareAbort(sender)
    throw error
  } finally {
    ipcMain.removeListener(APP_RELAUNCH_PREPARE_REPLY_CHANNEL, onReply)
  }
}
