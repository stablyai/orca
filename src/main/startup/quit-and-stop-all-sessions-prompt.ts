import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { translateMain } from '../i18n/main-i18n'

const CONFIRM_BUTTON_INDEX = 0
const CANCEL_BUTTON_INDEX = 1
const ACKNOWLEDGE_BUTTON_INDEX = 0

/** Asks before Quit Completely; resolves true only when the user confirms. */
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
    title: translateMain('quitAndStopAllSessions.title', 'Quit Completely'),
    message: translateMain(
      'quitAndStopAllSessions.message',
      'Stop all terminal sessions and quit Orca?'
    ),
    detail: translateMain(
      'quitAndStopAllSessions.detail',
      "Orca closes every terminal tab and stops its session, including agents running in terminals, then quits. Plain Quit keeps them running so Orca reattaches on next launch. Terminal sessions on remote hosts may keep running there. Unsaved terminal work is lost, and the closed tabs don't come back on next launch. This can't be undone."
    )
  })
  return response === CONFIRM_BUTTON_INDEX
}

/** Explains that nothing was stopped because not every session can be listed; never confirms. */
export async function explainStopAllSessionsUnavailable(
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
): Promise<false> {
  await showMessageBox({
    type: 'info',
    buttons: [translateMain('quitAndStopAllSessions.ok', 'OK')],
    defaultId: ACKNOWLEDGE_BUTTON_INDEX,
    cancelId: ACKNOWLEDGE_BUTTON_INDEX,
    noLink: true,
    title: translateMain('quitAndStopAllSessions.title', 'Quit Completely'),
    message: translateMain(
      'quitAndStopAllSessions.unavailableMessage',
      "Orca can't stop every terminal session right now."
    ),
    detail: translateMain(
      'quitAndStopAllSessions.unavailableDetail',
      'Nothing was stopped. Try again once your terminals have opened. If a terminal says it was opened in a newer version of Orca, reopen it first. If your terminals are already open, quit and reopen Orca, then try again.'
    )
  })
  return false
}
