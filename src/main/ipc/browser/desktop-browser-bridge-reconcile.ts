/** Dependency-free hooks so SSH, settings and transport paths can steer the desktop browser bridge. */
type DesktopBrowserBridgeControl = {
  reconcile(): void
  resetEnvironment(environmentId: string): void
}

let control: DesktopBrowserBridgeControl | null = null

export function setDesktopBrowserBridgeControl(next: DesktopBrowserBridgeControl | null): void {
  control = next
}

export function requestDesktopBrowserBridgeReconcile(): void {
  try {
    control?.reconcile()
  } catch (error) {
    console.warn('[desktop-browser-bridge] reconcile failed:', error)
  }
}

/** A retired transport must not leave a bridge socket that still authenticates as the old peer. */
export function resetDesktopBrowserBridgeEnvironment(environmentId: string): void {
  try {
    control?.resetEnvironment(environmentId)
  } catch (error) {
    console.warn('[desktop-browser-bridge] reset failed:', error)
  }
}
