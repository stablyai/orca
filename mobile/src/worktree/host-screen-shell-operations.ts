export type HostScreenShellOperations = {
  openSettings?: () => void
  leaveHost(): void
  navigateFromHostList(target: string): void
  openConnectionDiagnostics(): void
  openExternalUrl(url: string): Promise<void>
  reconnect(): Promise<void>
  repairPairing(): void
  removeHost(): Promise<void>
}
