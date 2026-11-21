// Only local PTYs belong here; remote PIDs cannot be sampled by this host.

export type PtyRegistration = {
  ptyId: string
  worktreeId: string | null
  sessionId: string | null
  paneKey: string | null
  // Capture at spawn to avoid IPC lookups; unavailable PIDs retain zero-attribution rows.
  pid: number | null
}

const registry = new Map<string, PtyRegistration>()
// Kept on mutation so a per-tick "anything to sample?" check stays O(1).
let registeredWithPid = 0

export function registerPty(entry: PtyRegistration): void {
  // Re-registering keeps the entry's place: attribution of overlapping trees follows that order.
  const previous = registry.get(entry.ptyId)
  registeredWithPid += (entry.pid != null ? 1 : 0) - (previous?.pid != null ? 1 : 0)
  registry.set(entry.ptyId, entry)
}

export function unregisterPty(ptyId: string): void {
  const existing = registry.get(ptyId)
  if (existing && registry.delete(ptyId) && existing.pid != null) {
    registeredWithPid -= 1
  }
}

/** The shell PID a PTY published at spawn or adoption; null when its host published none. */
export function getRegisteredPtyPid(ptyId: string): number | null {
  return registry.get(ptyId)?.pid ?? null
}

export function hasRegisteredPtyWithPid(): boolean {
  return registeredWithPid > 0
}

export function listRegisteredPtys(): PtyRegistration[] {
  return [...registry.values()]
}
