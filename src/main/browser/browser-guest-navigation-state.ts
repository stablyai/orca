let warnedMissingNavigationHistory = false

export function readGuestNavigationState(guest: Electron.WebContents): {
  canGoBack: boolean
  canGoForward: boolean
} {
  const history = guest.navigationHistory
  // Why: Electron always provides navigationHistory, so `false` here is an API break, not a
  // page with no history — say so once instead of silently greying out Back/Forward forever.
  if (typeof history?.canGoBack !== 'function' || typeof history?.canGoForward !== 'function') {
    if (!warnedMissingNavigationHistory) {
      warnedMissingNavigationHistory = true
      console.warn(
        '[browser-guest] webContents.navigationHistory is unavailable; Back/Forward stay disabled'
      )
    }
    return { canGoBack: false, canGoForward: false }
  }
  return {
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward()
  }
}

export async function readGuestCdpNavigationState(
  guest: Electron.WebContents
): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
  try {
    const result = (await guest.debugger.sendCommand('Page.getNavigationHistory')) as {
      currentIndex?: unknown
      entries?: unknown
    }
    if (typeof result.currentIndex === 'number' && Array.isArray(result.entries)) {
      return {
        canGoBack: result.currentIndex > 0,
        canGoForward: result.currentIndex < result.entries.length - 1
      }
    }
  } catch {
    // Electron's navigationHistory remains available if CDP detaches mid-event.
  }
  return readGuestNavigationState(guest)
}
