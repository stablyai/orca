import {
  browserDownloadDestinationReservations,
  splitBrowserDownloadRelativePath,
  type BrowserDownloadTargetDestination
} from '../../downloads/browser-download-destination'
import { BrowserExtensionApiError } from '../api-runtime/browser-extension-namespace-registry'

/** A folder path and name under Downloads, saved there exactly (overwrite) or uniquified. */
type DownloadTarget = { directories: string[]; filename: string; overwrite: boolean }

/** A plain name in Downloads, a nested or overwritten target, or with saveAs the path chosen. */
export type DownloadPlace = { filename?: string; target?: DownloadTarget; savePath?: string }

/** Chrome's rule: relative to Downloads, no back-references; folders are created as needed. */
export function requestedPlace(
  raw: string | undefined,
  overwrite: boolean
): Pick<DownloadPlace, 'filename' | 'target'> {
  if (raw === undefined) {
    if (overwrite) {
      throw new BrowserExtensionApiError('Orca overwrites only a file named by "filename"')
    }
    return {}
  }
  const segments = splitBrowserDownloadRelativePath(raw)
  if (!segments) {
    throw new BrowserExtensionApiError('Invalid filename')
  }
  if (segments.length === 1 && !overwrite) {
    return { filename: raw }
  }
  return {
    filename: raw,
    target: { directories: segments.slice(0, -1), filename: segments.at(-1) ?? '', overwrite }
  }
}

export async function reserveTarget(
  target: DownloadTarget,
  signal: AbortSignal,
  owner: Electron.WebContents
): Promise<BrowserDownloadTargetDestination> {
  let destination: BrowserDownloadTargetDestination
  try {
    destination = await browserDownloadDestinationReservations.reserveTarget(target.filename, {
      directories: target.directories,
      overwrite: target.overwrite
    })
  } catch (error) {
    throw new BrowserExtensionApiError(
      error instanceof Error ? error.message : 'Could not choose a Downloads file name'
    )
  }
  // Why again: the context or the tab can go while the destination is reserved.
  try {
    requireDownloadContext(signal, owner)
  } catch (error) {
    browserDownloadDestinationReservations.release(destination.reservationKey)
    throw error
  }
  return destination
}

/** Why the tab too: it can close during the save dialog, an earlier identical start, or the reservation. */
export function requireDownloadContext(signal: AbortSignal, owner?: Electron.WebContents): void {
  if (signal.aborted) {
    throw new BrowserExtensionApiError('Extension context was unloaded')
  }
  if (owner?.isDestroyed()) {
    throw new BrowserExtensionApiError('The tab closed before the download started')
  }
}
