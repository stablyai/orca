// An SSH session counts as use of an Orca Cloud workspace, so idle sleep does not stop a VM under
// someone typing in VS Code. Only client-to-VM traffic above keepalive noise counts: an editor
// window left open with nobody using it still lets the workspace sleep.

/** ssh keepalives (ServerAliveInterval 30) send ~200 B/min; a few keystrokes exceed this. */
export const CLOUD_SSH_ACTIVE_BYTES_PER_MINUTE = 2048
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
