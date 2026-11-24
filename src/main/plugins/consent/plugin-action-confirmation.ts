import { dialog, type BrowserWindow } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import type { PluginActionConfirmation } from './plugin-confirmation-subject'

export type { PluginActionConfirmation }

export type PluginActionConfirmationRequest = {
  /** One line that names the plugin and what it wants to do. */
  message: string
  detail?: string
  /** The button that allows it; Cancel is the default. */
  confirmLabel: string
  cancelLabel?: string
  /** An "always allow" choice; its state comes back as `remember`. */
  checkboxLabel?: string
}

/** A sheet on a hidden or minimized window would wait, unseen, forever. */
export function canConfirmInWindow(window: BrowserWindow | null): window is BrowserWindow {
  return !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
}

/**
 * Orca asks the person before a plugin acts on their behalf; where nobody can see the question,
 * nobody is asked and the answer is `unavailable`.
 */
export async function confirmPluginAction(
  window: BrowserWindow | null,
  request: PluginActionConfirmationRequest,
  /** Closes the question, unanswered, once whoever asked it is gone. */
  signal?: AbortSignal
): Promise<{ answer: PluginActionConfirmation; remember: boolean }> {
  if (!canConfirmInWindow(window) || signal?.aborted) {
    return { answer: 'unavailable', remember: false }
  }
  const { response, checkboxChecked } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: [
      request.confirmLabel,
      request.cancelLabel ?? translateMain('plugins.actionConfirmation.cancel', 'Cancel')
    ],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: request.message,
    ...(request.detail ? { detail: request.detail } : {}),
    ...(request.checkboxLabel ? { checkboxLabel: request.checkboxLabel } : {}),
    ...(signal ? { signal } : {})
  })
  if (signal?.aborted) {
    // Closed because the caller went away: nobody answered, so this is no refusal.
    return { answer: 'unavailable', remember: false }
  }
  return response === 0
    ? { answer: 'allowed', remember: checkboxChecked }
    : { answer: 'cancelled', remember: false }
}
