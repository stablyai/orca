/** Backend-specific slave-device paths are optional on POSIX and absent on Windows. */
export function readPtsName(proc: unknown): string | undefined {
  if (typeof proc !== 'object' || proc === null || !('ptsName' in proc)) {
    return undefined
  }
  return typeof proc.ptsName === 'string' && proc.ptsName.length > 0 ? proc.ptsName : undefined
}
