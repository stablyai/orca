export type HostScreenShellOperations = {
  leaveHost(): void
  navigateFromHostList(target: string): void
  // Diagnostics read the shell's own transport log, so the hosted page cannot render it.
  openConnectionDiagnostics(): void
  openExternalUrl(url: string): Promise<void>
  reconnect(): Promise<void>
  repairPairing(): void
  removeHost(): Promise<void>
}
