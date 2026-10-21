import type { BrowserManager } from './browser-manager'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'

export type BrowserClientPageGuestBindingInput = {
  registration: BrowserRoutePageGuestIdentity
  browserProfileId: string
}

/**
 * Binds a client-hosted page's guest to its page id in the browser manager. Without it the manager
 * knows the guest only after an agent automation command, so a user-driven page's downloads (and
 * its popups' downloads) resolve no owning page: they fail closed, and no download event reaches
 * the renderer at all.
 */
export type BrowserClientPageGuestBinding = {
  bindReplacement?(input: BrowserClientPageGuestBindingInput): void
  bind(input: BrowserClientPageGuestBindingInput): void
  release(registration: BrowserRoutePageGuestIdentity): void
}

export function createBrowserClientPageGuestBinding(
  browserManager: Pick<
    BrowserManager,
    'getGuestWebContentsId' | 'registerGuest' | 'unregisterGuest'
  >
): BrowserClientPageGuestBinding {
  return {
    bindReplacement: ({ registration, browserProfileId }) => {
      const bound = browserManager.registerGuest(
        {
          browserPageId: registration.browserPageId,
          sessionProfileId: browserProfileId,
          webContentsId: registration.webContentsId,
          rendererWebContentsId: registration.rendererWebContentsId
        },
        { retainPreviousGuestPolicies: true }
      )
      if (
        !bound ||
        browserManager.getGuestWebContentsId(registration.browserPageId) !==
          registration.webContentsId
      ) {
        throw new Error('browser_client_page_guest_registration_failed')
      }
    },
    bind: ({ registration, browserProfileId }) => {
      if (
        browserManager.getGuestWebContentsId(registration.browserPageId) ===
        registration.webContentsId
      ) {
        return
      }
      const bound = browserManager.registerGuest({
        browserPageId: registration.browserPageId,
        sessionProfileId: browserProfileId,
        webContentsId: registration.webContentsId,
        rendererWebContentsId: registration.rendererWebContentsId
      })
      if (!bound) {
        // Downloads keep failing closed rather than landing on this desktop, so page creation stands.
        console.warn(
          '[browser-client-page] Guest binding refused; downloads on this page cannot report progress.'
        )
      }
    },
    release: (registration) => {
      // Only the binding this page still owns: an automation retirement may have dropped it already.
      if (
        browserManager.getGuestWebContentsId(registration.browserPageId) !==
        registration.webContentsId
      ) {
        return
      }
      browserManager.unregisterGuest(registration.browserPageId)
    }
  }
}
