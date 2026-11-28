// Why a live flag: the Settings switch turns extensions on and off without a restart, so
// every entry point asks at call time.
let supportEnabled = false

export function setBrowserExtensionSupportEnabled(enabled: boolean): void {
  supportEnabled = enabled
}

export function isBrowserExtensionSupportEnabled(): boolean {
  return supportEnabled
}

/** English for CLI, chrome.management and logs; the renderer words it from `failure` instead. */
export const BROWSER_EXTENSION_SUPPORT_DISABLED_ERROR =
  'Turn on browser extensions in Settings › Browser › Extensions'
