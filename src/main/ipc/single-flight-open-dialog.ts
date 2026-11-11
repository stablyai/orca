import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { dialog } from 'electron'

const CANCELED: OpenDialogReturnValue = { canceled: true, filePaths: [] }

let openDialogInFlight = false

// Why: repeated clicks on a picker button (or clicks landing before the native
// dialog appears) used to queue one OS file picker per click. Only one picker
// may be open at a time; overlapping requests resolve as canceled so callers
// treat them as a no-op instead of adding the same path twice.
export async function showSingleFlightOpenDialog(
  options: OpenDialogOptions,
  parentWindow?: BrowserWindow | null
): Promise<OpenDialogReturnValue> {
  if (openDialogInFlight) {
    return CANCELED
  }
  openDialogInFlight = true
  try {
    return parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options)
  } finally {
    openDialogInFlight = false
  }
}
