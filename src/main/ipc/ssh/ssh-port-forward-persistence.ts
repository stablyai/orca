import type { BrowserWindow } from 'electron'
import type { SavedPortForward } from '../../../shared/ssh-types'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { connectionManager, portForwardManager } from './ssh-ipc-context'
import { broadcastPortForwards } from './ssh-renderer-broadcast'

function forwardKey(forward: SavedPortForward): string {
  return `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`
}

// Why: after user add/remove/update the runtime manager is the source of truth — persist exactly its entries (unrestored ones handled by a separate helper).
export function persistPortForwards(targetId: string): void {
  const active = portForwardManager!.listForwards(targetId)
  const saved: SavedPortForward[] = active.map((f) => ({
    localPort: f.localPort,
    remoteHost: f.remoteHost,
    remotePort: f.remotePort,
    label: f.label
  }))
  getSshTargetRegistryStore()!.updateTarget(targetId, {
    portForwards: saved.length > 0 ? saved : undefined
  })
}

// Why: keep forwards that failed to restore in the persisted list so they retry on next reconnect instead of being silently dropped.
export function persistPortForwardsWithUnrestored(targetId: string): void {
  const active = portForwardManager!.listForwards(targetId)
  const activeKeys = new Set(active.map(forwardKey))

  const existing = getSshTargetRegistryStore()!.getTarget(targetId)?.portForwards ?? []
  const unrestored = existing.filter((pf) => !activeKeys.has(forwardKey(pf)))

  const saved: SavedPortForward[] = [
    ...active.map((f) => ({
      localPort: f.localPort,
      remoteHost: f.remoteHost,
      remotePort: f.remotePort,
      label: f.label
    })),
    ...unrestored
  ]
  getSshTargetRegistryStore()!.updateTarget(targetId, {
    portForwards: saved.length > 0 ? saved : undefined
  })
}

export async function restorePortForwards(
  targetId: string,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (!target?.portForwards?.length) {
    return
  }
  const conn = connectionManager!.getConnection(targetId)
  if (!conn) {
    return
  }
  // Why: a forward bound to the replaced transport still holds its local port but reaches nothing.
  await portForwardManager!.closeStaleForwards(targetId, conn)
  const live = new Set(portForwardManager!.listForwards(targetId).map(forwardKey))

  // Why: keep failed restores in persisted state — a failure may be transient (port temporarily busy), so retry on next reconnect.
  for (const saved of target.portForwards) {
    if (live.has(forwardKey(saved))) {
      continue
    }
    // Why: a reconnect mid-loop swaps the connection object; bail on identity change so we don't add forwards to a stale conn (leaking listeners).
    if (connectionManager!.getConnection(targetId) !== conn) {
      return
    }
    try {
      const entry = await portForwardManager!.addForward(
        targetId,
        conn,
        saved.localPort,
        saved.remoteHost,
        saved.remotePort,
        saved.label
      )
      // Why: a disconnect during the add already swept this target's forwards; this one came after.
      if (connectionManager!.getConnection(targetId) !== conn) {
        await portForwardManager!.removeForwardAndWait(entry.id)
        return
      }
    } catch (err) {
      console.warn(
        `[ssh] Failed to restore forward :${saved.localPort} → ${saved.remoteHost}:${saved.remotePort}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  persistPortForwardsWithUnrestored(targetId)
  broadcastPortForwards(getMainWindow, targetId)
}
