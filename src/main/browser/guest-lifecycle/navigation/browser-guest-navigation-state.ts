export function readGuestNavigationState(guest: Electron.WebContents): {
  canGoBack: boolean
  canGoForward: boolean
} {
  return {
    canGoBack: guest.navigationHistory.canGoBack(),
    canGoForward: guest.navigationHistory.canGoForward()
  }
}
