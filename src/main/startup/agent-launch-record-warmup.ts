import type { BrowserWindow } from 'electron'
import { mainProcessState as state } from './main-process-state'

// Defer synchronous disk work (95-280ms measured under load) past first-load renderer startup.
export const AGENT_LAUNCH_RECORD_WARMUP_DELAY_MS = 1_500

/** Warm once startup settles and a launch-capable client connects, avoiding first-launch disk cost. */
function markStartupSettled(): void {
  state.runtime?.noteAgentLaunchStartupSettled()
}

function warmLater(): void {
  setTimeout(markStartupSettled, AGENT_LAUNCH_RECORD_WARMUP_DELAY_MS).unref?.()
}

/** Defer until after first load to protect startup and first paint. */
export function scheduleAgentLaunchRecordWarmup(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || !window.webContents.isLoading()) {
    warmLater()
    return
  }
  window.webContents.once('did-finish-load', warmLater)
}
