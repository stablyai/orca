import type { BrowserWindow } from 'electron'
import type { SavedPortForward } from '../../../shared/ssh-types'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { connectionManager, portForwardManager } from './ssh-ipc-context'
import { broadcastPortForwards } from './ssh-renderer-broadcast'
import { PortForwardTornDownError } from '../../ssh/port-forwarding/ssh-port-forward'
import {
  clearForwardFailure,
  forwardKey,
  isForwardBackingOff,
  recordForwardFailure
} from './ssh-port-forward-unrestored'

/**
 * Saves the live forwards plus every saved one not live, so a forward a restart left unrestored
 * survives a later add or edit (#32484). `dropped` names the one forward the user removed or edited away.
 */
export function persistPortForwards(
  targetId: string,
  dropped?: Pick<SavedPortForward, 'localPort' | 'remoteHost' | 'remotePort'>
): void {
  const active = portForwardManager!.listForwards(targetId)
  // A live forward on a saved one's local port replaced it, whatever its destination.
  const activePorts = new Set(active.map((forward) => forward.localPort))
  const droppedKey = dropped ? forwardKey(dropped) : null

  const existing = getSshTargetRegistryStore()!.getTarget(targetId)?.portForwards ?? []
  const unrestored = existing.filter(
    (pf) => !activePorts.has(pf.localPort) && forwardKey(pf) !== droppedKey
  )

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

/** Whether every saved forward has a live runtime entry. */
export function savedPortForwardsAllLive(targetId: string): boolean {
  const live = new Set(portForwardManager!.listForwards(targetId).map(forwardKey))
  const saved = getSshTargetRegistryStore()!.getTarget(targetId)?.portForwards ?? []
  return saved.every((forward) => live.has(forwardKey(forward)))
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
    if (live.has(forwardKey(saved)) || isForwardBackingOff(targetId, saved)) {
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
      clearForwardFailure(targetId, saved)
    } catch (err) {
      // A teardown or reconnect cancelled this start; the next transport retries without a backoff.
      if (
        err instanceof PortForwardTornDownError ||
        connectionManager!.getConnection(targetId) !== conn
      ) {
        return
      }
      recordForwardFailure(targetId, saved)
      console.warn(
        `[ssh] Failed to restore forward :${saved.localPort} → ${saved.remoteHost}:${saved.remotePort}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  persistPortForwards(targetId)
  broadcastPortForwards(getMainWindow, targetId)
}
