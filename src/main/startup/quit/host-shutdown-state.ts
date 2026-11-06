// Set synchronously once the host commits to shutting down (Electron will-quit, orcad shutdown admission).
let hostShuttingDown = false

export function markHostShuttingDown(): void {
  hostShuttingDown = true
}

export function isHostShuttingDown(): boolean {
  return hostShuttingDown
}
