// An SSH session counts as use of an Orca Cloud workspace, so idle sleep does not stop a VM under
// someone typing in VS Code. Only client-to-VM traffic that reads as use counts (see
// ForwardUseMeter): an editor window left open with nobody using it still lets the workspace sleep.

/** Matches the lease policy's PTY quiet window. */
const ACTIVE_FOR_MS = 2 * 60_000

const lastActiveAt = new Map<string, number>()

export function noteCloudSshActivity(runtimeEnvironmentId: string, at = Date.now()): void {
  lastActiveAt.set(runtimeEnvironmentId, at)
}

export function cloudSshActiveAt(runtimeEnvironmentId: string, now = Date.now()): number | null {
  const at = lastActiveAt.get(runtimeEnvironmentId)
  if (at === undefined) {
    return null
  }
  if (now - at > ACTIVE_FOR_MS) {
    lastActiveAt.delete(runtimeEnvironmentId)
    return null
  }
  return at
}

export function resetCloudSshActivityForTests(): void {
  lastActiveAt.clear()
}
