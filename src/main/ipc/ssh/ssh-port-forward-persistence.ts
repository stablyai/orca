import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { connectionManager, portForwardManager } from './ssh-ipc-context'
import { broadcastPortForwards } from './ssh-renderer-broadcast'
import { PortForwardTornDownError } from '../../ssh/port-forwarding/ssh-port-forward'
import { assertIpv6LoopbackPortFree } from '../../ssh/port-forwarding/local-forward-ipv6-loopback-probe'
import {
  isForwardBackingOff,
  recordForwardFailure,
  recordForwardStarted
} from './ssh-port-forward-unrestored'
import {
  forwardKey,
  nextSavedPortForwards,
  type ForwardMapping
} from '../../ssh/port-forwarding/saved-port-forward-list'

/** Retain inactive saved forwards across edits; dropped excludes the removed/replaced mapping (#32484). */
export function persistPortForwards(targetId: string, dropped?: ForwardMapping): void {
  const existing = getSshTargetRegistryStore()!.getTarget(targetId)?.portForwards ?? []
  const saved = nextSavedPortForwards(
    portForwardManager!.listForwards(targetId),
    existing,
    dropped ? [dropped] : []
  )
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

export async function restorePortForwards(targetId: string): Promise<void> {
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
      await assertIpv6LoopbackPortFree(saved.localPort)
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
      recordForwardStarted(targetId, saved)
    } catch (err) {
      // A teardown or reconnect cancelled this start; the next transport retries without a backoff.
      if (
        err instanceof PortForwardTornDownError ||
        conn.isDisposed() ||
        connectionManager!.getConnection(targetId) !== conn
      ) {
        return
      }
      recordForwardFailure(targetId, saved, err)
      console.warn(
        `[ssh] Failed to restore forward :${saved.localPort} → ${saved.remoteHost}:${saved.remotePort}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  persistPortForwards(targetId)
  broadcastPortForwards(targetId)
}
