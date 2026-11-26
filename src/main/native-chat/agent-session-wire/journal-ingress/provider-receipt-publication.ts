/** Optional receipt publication cannot delay or fail the provider frame it accompanies. */
export function publishProviderReceipt(publish: () => void | Promise<void>): void {
  try {
    void publish()?.catch(() => undefined)
  } catch {
    // The ordinary provider echo can still settle the send.
  }
}
