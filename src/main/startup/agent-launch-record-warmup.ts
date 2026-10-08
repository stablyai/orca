import type { BrowserWindow } from 'electron'
import { mainProcessState as state } from './main-process-state'

// Why a delay after load: the open is synchronous disk work on the main thread (4-16 ms measured on
// an idle Mac, 95-280 ms on a loaded one), and the renderer's own start runs right after first load.
export const AGENT_LAUNCH_RECORD_WARMUP_DELAY_MS = 1_500

/** Startup is settled: the runtime may open the launch record once a client that can launch is
 *  connected too, so that first launch does not pay for it. */
function markStartupSettled(): void {
  state.runtime?.noteAgentLaunchStartupSettled()
}

function warmLater(): void {
  setTimeout(markStartupSettled, AGENT_LAUNCH_RECORD_WARMUP_DELAY_MS).unref?.()
}

/** After the window's first load, so startup and the first paint never wait on it. */
export function scheduleAgentLaunchRecordWarmup(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || !window.webContents.isLoading()) {
    warmLater()
    return
  }
  window.webContents.once('did-finish-load', warmLater)
}
