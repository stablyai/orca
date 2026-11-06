// Why a live flag: the experimental setting turns extensions on and off without a restart, so
// every entry point asks at call time.
let supportEnabled = false

export function setBrowserExtensionSupportEnabled(enabled: boolean): void {
  supportEnabled = enabled
}

export function isBrowserExtensionSupportEnabled(): boolean {
  return supportEnabled
}
