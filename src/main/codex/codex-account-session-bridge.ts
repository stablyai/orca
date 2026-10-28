// The remaining distro-local bridge shares this shutdown guard.
let stopping = false
export function isCodexAccountSessionBridgeStopping(): boolean {
  return stopping
}
export function stopCodexAccountSessionBridges(): void {
  stopping = true
}
