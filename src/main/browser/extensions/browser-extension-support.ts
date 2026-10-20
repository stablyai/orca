// Why read once: loaded extensions, preloads and IPC wiring are not torn down live, so the
// experimental setting takes effect on the next launch.
let supportEnabled = false

export function setBrowserExtensionSupportEnabled(enabled: boolean): void {
  supportEnabled = enabled
}

export function isBrowserExtensionSupportEnabled(): boolean {
  return supportEnabled
}
