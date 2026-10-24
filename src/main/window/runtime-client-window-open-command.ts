import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { openNativeDesktopWindow } from './native-desktop-windows'

/** Menu and main-process shortcut entry: opens an extra window and says so when it cannot. */
export function openRuntimeClientWindowFromUserCommand(): void {
  const result = openNativeDesktopWindow()
  if (result.ok) {
    return
  }
  const options: MessageBoxOptions = {
    type: 'warning',
    message: translateMain('multiWindow.openFailed', 'Could not open a new window'),
    // Why only the code: pairing guidance can name the runtime endpoint.
    detail: translateMain('multiWindow.openFailedDetail', 'Reason: {{reason}}', {
      reason: result.reason.split(':')[0]
    })
  }
  const parent = BrowserWindow.getFocusedWindow()
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
}
