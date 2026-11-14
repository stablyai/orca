import { ipcMain, webContents, type Session } from 'electron'
import {
  BROWSER_AGENT_LEAD_CHANNEL,
  BROWSER_AGENT_LEAD_QUERY_CHANNEL,
  BROWSER_PRINT_REFUSED_CHANNEL,
  BROWSER_SYSTEM_DIALOGS_PRELOAD_FILE
} from '../../../../shared/browser-system-dialogs'
import {
  registerBrowserSessionFramePreload,
  unregisterBrowserSessionFramePreload
} from '../../sessions/browser-session-frame-preloads'
import {
  listBrowserRouteGuestPopups,
  resolveBrowserRouteGuestPopupOpener
} from '../../routing/guest-authority/browser-route-guest-popup-ownership'
import { browserManager } from '../manager/browser-manager'
import { cancelBrowserPasskeyRequests } from '../../webauthn/browser-passkey-requests'

const PRELOAD_ID = 'orca-browser-system-dialogs'

/** Watches the session's pages for passkey requests and print dialogs, which Electron doesn't report. */
export function watchBrowserSystemDialogs(browserSession: Session): void {
  if (
    !registerBrowserSessionFramePreload(
      browserSession,
      PRELOAD_ID,
      BROWSER_SYSTEM_DIALOGS_PRELOAD_FILE
    )
  ) {
    console.warn('[browser] System dialog preload is missing')
  }
}

export function unwatchBrowserSystemDialogs(browserSession: Session): void {
  unregisterBrowserSessionFramePreload(browserSession, PRELOAD_ID)
}

/** Keeps every watched page's frames told whether the agent leads it; once per app. */
export function listenForBrowserSystemDialogs(): void {
  ipcMain.on(BROWSER_AGENT_LEAD_QUERY_CHANNEL, (event) => {
    event.reply(BROWSER_AGENT_LEAD_CHANNEL, browserManager.isAgentLedGuest(event.sender.id))
  })
  ipcMain.on(BROWSER_PRINT_REFUSED_CHANNEL, (event) => {
    browserManager.reportRefusedPrint(event.sender.id, event.senderFrame?.origin ?? '')
  })
  browserManager.setAgentLeadListener((guestWebContentsId, led) => {
    // SSH route popups follow their opener's lead.
    const routePopups = listBrowserRouteGuestPopups().filter(
      (popupId) => resolveBrowserRouteGuestPopupOpener(popupId) === guestWebContentsId
    )
    for (const id of [guestWebContentsId, ...routePopups]) {
      publishAgentLead(id, led)
      // A passkey request held from Windows Hello for the agent can't resume; cancelling it lets
      // the page offer its own retry to the user who just came back.
      if (!led && process.platform === 'win32') {
        cancelBrowserPasskeyRequests(id)
      }
    }
  })
}

function publishAgentLead(guestWebContentsId: number, led: boolean): void {
  try {
    const guest = webContents.fromId(guestWebContentsId)
    if (!guest || guest.isDestroyed()) {
      return
    }
    for (const frame of guest.mainFrame.framesInSubtree) {
      frame.send(BROWSER_AGENT_LEAD_CHANNEL, led)
    }
  } catch {
    // Best-effort: a guest or frame torn down mid-walk has no dialog left to guard.
  }
}
