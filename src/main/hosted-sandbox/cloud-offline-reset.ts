// Sign-out and profile switches drop the Orca Cloud offline cache and queued prompts. A seam with
// no imports, so profile code never loads the hosted-sandbox modules.
let reset: (() => void) | null = null

export function setCloudOfflineReset(next: (() => void) | null): void {
  reset = next
}

export function resetCloudOfflineData(): void {
  try {
    reset?.()
  } catch (error) {
    console.error(`[orca-cloud] clearing offline data failed: ${String(error)}`)
  }
}
