import type { BrowserWindow } from 'electron'
import type { SavedPortForward } from '../../../shared/ssh-types'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { connectionManager, portForwardManager } from './ssh-ipc-context'
import { broadcastPortForwards } from './ssh-renderer-broadcast'

function forwardKey(forward: SavedPortForward): string {
  return `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`
}

// User mutations persist the runtime list; failed restores are retained by the separate restore path.
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

// Keep failed restores saved so transient errors can retry on reconnect.
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
  // Replaced transports can leave forwards holding local ports but reaching nothing.
  await portForwardManager!.closeStaleForwards(targetId, conn)
  const live = new Set(portForwardManager!.listForwards(targetId).map(forwardKey))

  for (const saved of target.portForwards) {
    if (live.has(forwardKey(saved))) {
      continue
    }
    // Reconnect can replace the transport mid-loop; stop before adding stale listeners.
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
      // A concurrent disconnect swept older forwards; release this newly completed one too.
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
