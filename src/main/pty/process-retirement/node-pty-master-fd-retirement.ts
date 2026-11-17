/** Orca's node-pty patch retires the master fd to -1; later process answers are fallbacks, not observations.
 * Windows has no master fd; unpatched relay installations never publish retirement. */
export function isRetiredPtyMaster(proc: unknown): boolean {
  if (typeof proc !== 'object' || proc === null || !('fd' in proc)) {
    return false
  }
  const fd: unknown = proc.fd
  return typeof fd === 'number' && fd < 0
}
