import type { BrowserGuestRendererGoneReporter } from '../browser/browser-manager'
import type { ProcessGoneCrashDetails } from './process-gone-recorder'
import type { ProcessGoneRendererIdentity } from './process-gone-renderer-identity'

/** Mirrors the host's recordProcessGoneCrash so the wiring stays a one-line call. */
export type ProcessGoneCrashRecorder = (
  source: 'renderer' | 'child',
  processType: string,
  reason: string,
  exitCode: number | null,
  details: ProcessGoneCrashDetails,
  rendererIdentity?: ProcessGoneRendererIdentity
) => void

/**
 * Why a builder: as an inline closure in index.ts this glue was only coverable
 * by tests that bypassed it, so a transposed id pair stayed green (#15063).
 */
export function buildGuestRendererGoneReporter(
  recordCrash: ProcessGoneCrashRecorder
): BrowserGuestRendererGoneReporter {
  return (details, guestWebContentsId, guestKind, guestRendererProcessId) => {
    recordCrash(
      'renderer',
      'renderer',
      details.reason,
      details.exitCode ?? null,
      {
        processType: 'renderer',
        rendererKind: guestKind,
        webContentsId: guestWebContentsId,
        ...(guestRendererProcessId !== undefined
          ? { rendererProcessId: guestRendererProcessId }
          : {})
      },
      { webContentsId: guestWebContentsId, rendererProcessId: guestRendererProcessId }
    )
  }
}
