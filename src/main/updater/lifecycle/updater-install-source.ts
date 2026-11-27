let remoteRequested = false

/** Remote installs reuse the manual trigger; this marks the next install as requested by a paired client. */
export function markNextInstallRemote(): void {
  remoteRequested = true
}

/** The trigger as logged, without a separate synchronous breadcrumb before the install. */
export function installTriggerLabel(trigger: string): string {
  const label = remoteRequested ? 'remote' : trigger
  remoteRequested = false
  return label
}
