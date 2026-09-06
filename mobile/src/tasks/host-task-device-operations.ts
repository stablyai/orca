export type HostTaskDeviceOperations = {
  copyText(text: string): Promise<void>
  hapticMediumImpact(): void
  openExternalUrl(url: string): Promise<void>
}
