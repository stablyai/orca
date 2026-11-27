let pending: Promise<void> | null = null

/** Startup records the import so Help > Report Crash waits for it instead of racing it. */
export function trackUnrecoveredStallImport(importing: Promise<void>): void {
  pending = importing
}

export function unrecoveredStallImportSettled(): Promise<void> {
  return pending ?? Promise.resolve()
}
