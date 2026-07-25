// Why: the build-scoped #9891 fallback decision — run this launch's renderers
// unsandboxed after repeated launch-time STATUS_BREAKPOINT crashes — is resolved
// once before app.whenReady() and then read when creating each window. A shared
// flag lets every window creator (main window and the dashboard pop-out, which
// is spawned deep in an IPC handler) honor it without threading an option
// through every call site.
//
// IMPORTANT (security-relevant): the fallback works by creating those windows
// with webPreferences.sandbox:false, which Electron only honors PER-WINDOW when
// the app does NOT call app.enableSandbox(). Orca deliberately relies on
// per-window sandbox config so the default stays sandboxed and only the affected
// build's main/pop-out renderers opt out - webview guests and every other window
// remain sandboxed. Adding a global app.enableSandbox() would ignore the
// per-window opt-out entirely and silently neutralize this fallback (#9891
// machines would crash-loop again); don't, without a replacement.
let rendererSandboxFallbackActive = false

export function setRendererSandboxFallbackActive(value: boolean): void {
  rendererSandboxFallbackActive = value
}

export function isRendererSandboxFallbackActive(): boolean {
  return rendererSandboxFallbackActive
}
