import type { SavedBrowserTabsSource } from './tabs-and-windows/browser-extension-discarded-tabs'

// Why a live flag: the Settings switch turns extensions on and off without a restart, so
// every entry point asks at call time.
let supportEnabled = false

export function setBrowserExtensionSupportEnabled(enabled: boolean): void {
  supportEnabled = enabled
}

export function isBrowserExtensionSupportEnabled(): boolean {
  return supportEnabled
}

// Held here while startup skips loading the extension graph, so a later Settings
// enable still hands installBrowserExtensionSupport the saved workspace session.
let pendingSavedBrowserTabs: SavedBrowserTabsSource | null = null

export function takePendingSavedBrowserTabs(): SavedBrowserTabsSource | null {
  const pending = pendingSavedBrowserTabs
  pendingSavedBrowserTabs = null
  return pending
}

/** Avoid loading the browser-extension startup graph when extensions are disabled. */
export async function initializeBrowserExtensionSupportIfEnabled(options: {
  enabled: boolean
  savedBrowserTabs?: SavedBrowserTabsSource
}): Promise<void> {
  if (options.enabled) {
    const { initializeBrowserExtensionSupport } = await import('./browser-extension-startup')
    initializeBrowserExtensionSupport(options)
    return
  }
  pendingSavedBrowserTabs = options.savedBrowserTabs ?? null
  setBrowserExtensionSupportEnabled(false)
  void import('./profile-storage/browser-extension-retired-profile-storage')
    .then(({ removeRetiredBrowserExtensionProfileStorage }) =>
      removeRetiredBrowserExtensionProfileStorage()
    )
    .catch((error: unknown) => {
      console.warn('[browser-extensions] Could not remove retired profile storage:', error)
    })
}

/** English for CLI, chrome.management and logs; the renderer words it from `failure` instead. */
export const BROWSER_EXTENSION_SUPPORT_DISABLED_ERROR =
  'Turn on browser extensions in Settings › Browser › Extensions'
