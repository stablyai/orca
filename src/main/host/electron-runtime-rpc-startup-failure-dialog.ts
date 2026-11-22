import { dialog, type BrowserWindow } from 'electron'
import { createRuntimeRpcStartupFailureDialogOptions } from '../runtime/rpc/server/runtime-rpc-startup-failure'
import { waitForWindowToShow } from '../window/visibility/wait-for-window-to-show'

export async function showRuntimeRpcStartupFailureDialog(
  parentWindow: BrowserWindow,
  error: unknown
): Promise<void> {
  if (!(await waitForWindowToShow(parentWindow))) {
    return
  }
  try {
    await dialog.showMessageBox(parentWindow, createRuntimeRpcStartupFailureDialogOptions(error))
  } catch (dialogError) {
    console.error('[runtime] Failed to show RPC startup failure dialog:', dialogError)
  }
}
