import type { BrowserManager } from './browser-manager'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'

export type BrowserClientPageGuestBindingInput = {
  registration: BrowserRoutePageGuestIdentity
  browserProfileId: string
}

/** Register pages before automation so downloads and popups can resolve their owner. */
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
        // Download refusal preserves isolation, so a binding failure need not fail page creation.
        console.warn(
          '[browser-client-page] Guest binding refused; downloads on this page cannot report progress.'
        )
      }
    },
    release: (registration) => {
      // Retirement may already have removed or replaced this binding.
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
