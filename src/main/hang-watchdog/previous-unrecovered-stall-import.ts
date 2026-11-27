let pending: Promise<void> | null = null
let stallDetectedAt: number | null = null

/** Startup records the import so Help > Report Crash waits for it instead of racing it. */
export function trackUnrecoveredStallImport(importing: Promise<void>, detectedAt: number): void {
  pending = importing
  stallDetectedAt = detectedAt
}

/** Resolves to the imported stall's detectedAt, so an older native capture is not offered ahead of it. */
export async function unrecoveredStallImportSettled(): Promise<number | null> {
  await pending
  return stallDetectedAt
}
