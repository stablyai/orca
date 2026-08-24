import type { WebContents } from 'electron'

/**
 * Both ids travel under their names: positional `number` params let a caller
 * transpose them silently, re-keying dedupe on the webContents id (#15063).
 */
export type ProcessGoneRendererIdentity = {
  /** Which webContents observed the death — attribution evidence, never dedupe identity. */
  webContentsId: number
  /** Render-process-host id of the dead process; undefined when unreadable at event time. */
  rendererProcessId: number | undefined
}

/**
 * Reads the identity of the renderer process a render-process-gone event is
 * about. webContents.getProcessId() is the Chromium render-process-host id:
 * webContents sharing one OS renderer process (same-site popups, #15063)
 * share one host, distinct processes never do, and — unlike getOSProcessId(),
 * which already reads 0 by the time render-process-gone fires — the host
 * outlives its process, so it stays readable inside the event handler
 * (both verified live on Electron 43.1.0).
 */
export function readGoneRendererProcessId(webContents: WebContents): number | undefined {
  try {
    if (webContents.isDestroyed()) {
      return undefined
    }
    const processId = webContents.getProcessId()
    return Number.isInteger(processId) && processId >= 0 ? processId : undefined
  } catch {
    // Why: a teardown race can destroy the webContents mid-event; report the
    // death with unknown identity rather than drop it.
    return undefined
  }
}
