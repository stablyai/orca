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

export function registerPty(entry: PtyRegistration): void {
  registry.set(entry.ptyId, entry)
}

export function unregisterPty(ptyId: string): void {
  registry.delete(ptyId)
}

export function listRegisteredPtys(): PtyRegistration[] {
  return [...registry.values()]
}
