import type { CloudWorkspaceStatus } from './cloud-control-plane-client'

// The desktop's VM states (EphemeralVmRuntimeStatus) in the phone's words. A failed sleep leaves the
// VM up, so it still reads running. A failed wake joins 'failed' (labelled "Couldn't start") until the
// phone has a status of its own for it.
const FROM_DESKTOP: Record<string, CloudWorkspaceStatus> = {
  provisioning: 'creating',
  running: 'running',
  suspend_failed: 'running',
  suspended: 'sleeping',
  resume_failed: 'failed',
  failed: 'failed',
  cleanup_pending: 'deleting'
  // cleanup_failed and cleaned (the VM is gone) draw no dot: a 'deleting' pulse would never stop.
  // The desktop records no waking state, and a sleep from another client shows once it reconciles.
}

/** A paired desktop's row: is it an Orca Cloud workspace, and in what state (null when this build
 *  doesn't know the desktop's word for it)? Unchecked wire data, so any shape is tolerated. */
export function cloudWorktreeRowStatus(
  orcaCloud: unknown
): { status: CloudWorkspaceStatus | null } | null {
  if (!orcaCloud || typeof orcaCloud !== 'object' || !('status' in orcaCloud)) {
    return null
  }
  const raw = orcaCloud.status
  return { status: typeof raw === 'string' ? (FROM_DESKTOP[raw] ?? null) : null }
}
