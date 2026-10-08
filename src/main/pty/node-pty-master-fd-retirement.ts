/**
 * node-pty hands the master fd to libuv, and Orca's patch sets it to -1 in the same block that
 * gives up the handle (config/patches/node-pty@1.1.0.patch). Past that point every fd-addressed
 * answer is a stand-in rather than an error: the `process` getter names the spawn file instead of
 * whatever `tcgetpgrp` would have reported, so callers that need a real observation have to ask
 * about the descriptor first. Windows exposes no master fd, so it never reads as retired; an
 * unpatched (relay-installed) node-pty never retires the number at all.
 */
export function isRetiredPtyMaster(proc: unknown): boolean {
  if (typeof proc !== 'object' || proc === null || !('fd' in proc)) {
    return false
  }
  const fd: unknown = proc.fd
  return typeof fd === 'number' && fd < 0
}
