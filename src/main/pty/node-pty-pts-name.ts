/** Undeclared node-pty Unix slave path; absent on Windows and unsupported versions. */
export function readPtsName(proc: unknown): string | undefined {
  const value = (proc as { ptsName?: unknown } | null | undefined)?.ptsName
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
