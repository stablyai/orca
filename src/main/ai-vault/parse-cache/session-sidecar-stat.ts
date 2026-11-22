// Track sidecars separately so transcript byte offsets and read failures remain independent.

export type SessionSidecarStat = {
  path: string
  mtimeMs: number
  sizeBytes: number
}

export type SessionSidecarObservation =
  | SessionSidecarStat
  /** This agent declares no sidecar, or it does not exist. */
  | 'none'
  /** Unreadable this scan; absence is unproven. */
  | 'unknown'

/** Missing file means no sidecar; missing entry predates this field and must miss if a sidecar exists. */
export function sidecarUnchanged(
  entry: SessionSidecarObservation | undefined,
  file: SessionSidecarObservation | undefined
): boolean {
  const observed = file ?? 'none'
  if (observed === 'unknown' || entry === 'unknown') {
    return false
  }
  if (observed === 'none') {
    return entry === undefined || entry === 'none'
  }
  return (
    typeof entry === 'object' &&
    entry.path === observed.path &&
    entry.mtimeMs === observed.mtimeMs &&
    entry.sizeBytes === observed.sizeBytes
  )
}

// Older cache rows omit this field; reparse only when discovery finds a sidecar.
export function parsePersistedSidecar(value: unknown): SessionSidecarObservation | undefined {
  if (value === 'none' || value === 'unknown') {
    return value
  }
  if (!isRecord(value)) {
    return undefined
  }
  const { path, mtimeMs, sizeBytes } = value
  return typeof path === 'string' && typeof mtimeMs === 'number' && typeof sizeBytes === 'number'
    ? { path, mtimeMs, sizeBytes }
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
