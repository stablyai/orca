// Lifecycle code nudges Orca Cloud's lease schedulers through this seam, so it never imports the driver.
let sync: (() => void) | null = null

export function setHostedSessionSync(next: (() => void) | null): void {
  sync = next
}

/** Start or stop lease schedulers after a VM lifecycle change; a no-op when Orca Cloud is off. */
export function syncHostedSessions(): void {
  sync?.()
}
