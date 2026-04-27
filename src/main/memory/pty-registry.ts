/**
 * Lightweight side-table that lets the memory collector attribute PTY
 * processes back to the worktree that spawned them.
 *
 * Why a separate module rather than folding it into pty.ts: the PTY
 * subsystem has no other reason to know about worktree memory. Keeping
 * the registry here means the collector can evolve (e.g. start tracking
 * extra per-session metadata) without touching the critical-path spawn
 * handler. The write-side is just two calls — `register` on spawn,
 * `unregister` on teardown.
 *
 * Scope: local PTYs only. SSH-backed PTYs execute on a remote host, so
 * their memory does not contribute to Orca's process footprint and
 * cannot be queried with our local `ps` tree.
 */

export type PtyRegistration = {
  ptyId: string
  worktreeId: string | null
  sessionId: string | null
  paneKey: string | null
  // Why number | null: captured at spawn time so the collector does not have
  // to reach back into the IPC module on every snapshot to resolve it. It is
  // nullable because node-pty can return a process whose pid is briefly
  // unavailable (spawn succeeded but the OS hasn't published the pid yet);
  // storing null lets the collector render a zero-attribution row for that
  // PTY instead of throwing and dropping the whole snapshot.
  pid: number | null
}

const registry = new Map<string, PtyRegistration>()

export function registerPty(entry: PtyRegistration): void {
  registry.set(entry.ptyId, entry)
}

export function unregisterPty(ptyId: string): void {
  registry.delete(ptyId)
}

/** Snapshot of currently-registered local PTYs for the collector to walk. */
export function listRegisteredPtys(): PtyRegistration[] {
  return [...registry.values()]
}
