// Why: no imports, so mobile-theme (loaded by tests and the web entry too) never pulls in a native
// module. true-black-startup sets this before any screen evaluates mobile-theme.
// The terminal WebView is a separate bundle that never runs true-black-startup, so the app writes
// the flag into the page as a start value (see xtermWebViewSource) and it is read here instead.
let enabledAtStartup = (globalThis as { __orcaTrueBlack?: unknown }).__orcaTrueBlack === true

export function setTrueBlackAtStartup(enabled: boolean): void {
  enabledAtStartup = enabled
}

export function trueBlackAtStartup(): boolean {
  return enabledAtStartup
}
