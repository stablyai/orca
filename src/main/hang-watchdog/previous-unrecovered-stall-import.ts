let pending: Promise<number | null> | null = null

/** Startup records the import so Help > Report Crash waits for it instead of racing it. */
export function trackUnrecoveredStallImport(importing: Promise<number | null>): void {
  pending = importing
}

/** The detectedAt of the freeze startup actually filed, or null; an older native capture is not offered ahead of it. */
export function unrecoveredStallImportSettled(): Promise<number | null> {
  return pending ?? Promise.resolve(null)
}
