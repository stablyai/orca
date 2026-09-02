/**
 * node-pty's unix terminal exposes the slave device path (`/dev/ttys003`,
 * `/dev/pts/3`) but does not declare it on IPty, and the Windows terminal has no
 * equivalent. Read it defensively so callers get `undefined` rather than a throw
 * on a platform or version that lacks it.
 */
export function readPtsName(proc: unknown): string | undefined {
  const value = (proc as { ptsName?: unknown } | null | undefined)?.ptsName
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
