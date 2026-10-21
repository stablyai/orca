import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { translateMain } from '../i18n/main-i18n'

const CONFIRM_BUTTON_INDEX = 0
const CANCEL_BUTTON_INDEX = 1

/** Asks before Quit and Stop All Sessions; resolves true only when the user confirms. */
export async function confirmQuitAndStopAllSessions(
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
): Promise<boolean> {
  const { response } = await showMessageBox({
    type: 'warning',
    buttons: [
      translateMain('quitAndStopAllSessions.confirm', 'Stop Sessions and Quit'),
      translateMain('quitAndStopAllSessions.cancel', 'Cancel')
    ],
    // Why Cancel by default: stopping running agents can't be undone, so Return/Escape must not confirm it.
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    noLink: true,
    title: translateMain('quitAndStopAllSessions.title', 'Quit and Stop All Sessions'),
    message: translateMain(
      'quitAndStopAllSessions.message',
      'Stop all terminal sessions and quit Orca?'
    ),
    detail: translateMain(
      'quitAndStopAllSessions.detail',
      "Orca closes every terminal tab and stops its session, including agents running in terminals, then quits. Terminal sessions on remote hosts may keep running there. Unsaved terminal work is lost, and the closed tabs don't come back on next launch. This can't be undone."
    )
  })
  return response === CONFIRM_BUTTON_INDEX
}
