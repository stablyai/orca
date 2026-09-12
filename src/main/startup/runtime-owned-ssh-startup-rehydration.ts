import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { mayReconnectEphemeralVmRuntimeTransport } from '../../shared/ephemeral-vm-runtimes'
import { ensureRuntimeOwnedSshConnection } from '../ephemeral-vm-runtime-ssh'
import type { Store } from '../persistence'

/**
 * How long startup waits on these reconnects before releasing the terminal-restoration barrier.
 * A reachable sandbox lands well inside this; an unreachable one must not hold the barrier — and
 * with it every restored terminal, local ones included — for the SSH connect timeout (30s) plus
 * the provider wait. Reconnects that overrun keep running; only the waiting stops.
 */
export const STARTUP_SSH_REHYDRATION_BARRIER_BUDGET_MS = 4_000

/**
 * Reconnect the runtime-owned SSH transports for the workspaces this launch restores as active.
 *
 * Runtime-owned targets are hidden from the renderer and are never dialed by it, so after a
 * desktop or host restart nothing else re-establishes them: the runtime record and its SSH target
 * row survive while the PTY provider does not, and the first terminal or agent operation fails
 * with "No PTY provider for connection" (#19173).
 *
 * Scoped to restored-active workspaces so a large runtime store cannot turn startup into a fan-out
 * of connects, run in parallel with per-target failure isolation, and bounded: this sits on the
 * barrier that gates every restored terminal, local ones included, so an unreachable sandbox must
 * not hold it. Resolves when the reconnects settle or the budget elapses, whichever comes first.
 */
export async function rehydrateRuntimeOwnedSshForRestoredWorkspaces(args: {
  store: Store
  userDataPath: string
}): Promise<void> {
  const restoredWorkspaceIds = collectRestoredWorkspaceIds(args.store)
  if (restoredWorkspaceIds.size === 0) {
    return
  }
  const runtimes = listEphemeralVmRuntimes(args.userDataPath).filter(
    (runtime) =>
      runtime.connectionMode === 'ssh' &&
      runtime.workspaceId !== undefined &&
      restoredWorkspaceIds.has(runtime.workspaceId) &&
      mayReconnectEphemeralVmRuntimeTransport(runtime.status)
  )
  if (runtimes.length === 0) {
    return
  }
  const rehydrated = Promise.all(
    runtimes.map(async (runtime) => {
      try {
        await ensureRuntimeOwnedSshConnection({ runtime })
      } catch (error) {
        // Why not a status write: a transport failure is `unverifiable`, never evidence the
        // sandbox exited (docs/reference/ssh-execution-boundary.md). The record stays as it is,
        // and the next workspace activation retries.
        console.warn(
          `[ephemeral-vm] Could not restore the SSH transport for runtime ${runtime.id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    })
  )
  await releaseBarrierAfterBudget(rehydrated)
}

async function releaseBarrierAfterBudget(rehydrated: Promise<unknown>): Promise<void> {
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      rehydrated,
      new Promise<void>((resolve) => {
        releaseTimer = setTimeout(resolve, STARTUP_SSH_REHYDRATION_BARRIER_BUDGET_MS)
        // Why unref'd: a pending release must never be the reason the process stays alive.
        releaseTimer.unref?.()
      })
    ])
  } finally {
    clearTimeout(releaseTimer)
  }
}

function collectRestoredWorkspaceIds(store: Store): Set<string> {
  const ids = new Set<string>()
  // Sessions are partitioned per execution host, and a runtime-owned workspace lives under its
  // own host partition, so the active set has to be unioned across all of them.
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    const session = store.getWorkspaceSession(hostId)
    if (session.activeWorktreeId) {
      ids.add(session.activeWorktreeId)
    }
    for (const worktreeId of session.activeWorktreeIdsOnShutdown ?? []) {
      ids.add(worktreeId)
    }
  }
  return ids
}
