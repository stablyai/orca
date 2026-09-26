/**
 * Lightweight side-table of live local PTYs, keyed by id.
 *
 * Two consumers share it: the memory collector, which attributes PTY processes
 * back to the worktree that spawned them, and (via the session binder) the
 * OpenCode session→pane correlation, which reads the prompt-activity stamps the
 * PTY write paths leave here. The write side is `register` on spawn,
 * `unregister` on teardown, and `notePtyInput` on each prompt-activity write.
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
  /**
   * ms epoch of the last prompt activity on this PTY — a keystroke from the
   * renderer, or a prompt Orca delivered host-side. Absent until one arrives,
   * and dropped when the PTY is re-registered under a new incarnation. The
   * session binder reads it to decide which of two same-directory panes
   * submitted the prompt that created a session (#22838).
   */
  lastInputAtMs?: number
  /**
   * The stamp `lastInputAtMs` replaced. A session row appears *after* the
   * prompt that created it, so the creating pane's useful evidence is its
   * pre-creation stamp — and if it typed again after submitting, that evidence
   * is only visible here. Two slots recover the ordinary "submitted, then kept
   * typing" case; a third post-creation write evicts it.
   */
  previousInputAtMs?: number
}

const registry = new Map<string, PtyRegistration>()

export function registerPty(entry: PtyRegistration): void {
  registry.set(entry.ptyId, entry)
}

export function unregisterPty(ptyId: string): void {
  registry.delete(ptyId)
}

/**
 * Record prompt activity against a PTY, keeping the stamp it replaces so a
 * pane that submitted a prompt and then kept typing can still show the
 * submission. Ids the registry never learned (remote PTYs, already-torn-down
 * ones) are ignored so the row cannot be created by input alone.
 */
export function notePtyInput(ptyId: string, nowMs: number): void {
  const entry = registry.get(ptyId)
  if (entry) {
    entry.previousInputAtMs = entry.lastInputAtMs
    entry.lastInputAtMs = nowMs
  }
}

/** Snapshot of currently-registered local PTYs for the collector to walk. */
export function listRegisteredPtys(): PtyRegistration[] {
  return [...registry.values()]
}
