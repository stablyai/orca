import type { SshConnectionManager } from './connection/ssh-connection-manager'
import type { SshConnectionStore } from './targets/ssh-connection-store'
import type { SshPortForwardManager } from './port-forwarding/ssh-port-forward'
import type { SavedPortForward } from '../../shared/remote-runtime/ssh/ssh-types'

type PortForwardPersistenceDependencies = {
  store: Pick<SshConnectionStore, 'getTarget' | 'updateTarget'>
  connectionManager: Pick<SshConnectionManager, 'getConnection'>
  portForwardManager: SshPortForwardManager
}

function forwardKey(forward: SavedPortForward): string {
  return `${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`
}

function savedForwardFromEntry(entry: SavedPortForward): SavedPortForward {
  return {
    localPort: entry.localPort,
    remoteHost: entry.remoteHost,
    remotePort: entry.remotePort,
    ...(entry.label === undefined ? {} : { label: entry.label })
  }
}

/** Persists the forwards that are currently live for one target. */
export function persistSshPortForwards(
  dependencies: PortForwardPersistenceDependencies,
  targetId: string
): void {
  const saved = dependencies.portForwardManager
    .listForwards(targetId)
    .map((entry) => savedForwardFromEntry(entry))
  dependencies.store.updateTarget(targetId, {
    portForwards: saved.length > 0 ? saved : undefined
  })
}

/** Keeps failed restores in the profile so a later reconnect can retry them. */
export function persistSshPortForwardsWithUnrestored(
  dependencies: PortForwardPersistenceDependencies,
  targetId: string
): void {
  const active = dependencies.portForwardManager.listForwards(targetId)
  const activeKeys = new Set(active.map(forwardKey))
  const existing = dependencies.store.getTarget(targetId)?.portForwards ?? []
  const saved: SavedPortForward[] = [
    ...active.map((entry) => savedForwardFromEntry(entry)),
    ...existing.filter((entry) => !activeKeys.has(forwardKey(entry)))
  ]
  dependencies.store.updateTarget(targetId, {
    portForwards: saved.length > 0 ? saved : undefined
  })
}

/** Recreates the target's saved forwards after a connection becomes usable. */
export async function restoreSshPortForwards(
  dependencies: PortForwardPersistenceDependencies,
  targetId: string
): Promise<void> {
  const target = dependencies.store.getTarget(targetId)
  if (!target?.portForwards?.length) {
    return
  }
  const connection = dependencies.connectionManager.getConnection(targetId)
  if (!connection) {
    return
  }

  await dependencies.portForwardManager.closeStaleForwards(targetId, connection)
  const live = new Set(
    dependencies.portForwardManager.listForwards(targetId).map((entry) => forwardKey(entry))
  )

  for (const saved of target.portForwards) {
    if (live.has(forwardKey(saved))) {
      continue
    }
    // A reconnect can replace the connection while a previous restore is still awaiting a bind.
    if (dependencies.connectionManager.getConnection(targetId) !== connection) {
      return
    }
    try {
      const entry = await dependencies.portForwardManager.addForward(
        targetId,
        connection,
        saved.localPort,
        saved.remoteHost,
        saved.remotePort,
        saved.label
      )
      if (dependencies.connectionManager.getConnection(targetId) !== connection) {
        await dependencies.portForwardManager.removeForwardAndWait(entry.id)
        return
      }
    } catch (error) {
      console.warn(
        `[ssh] Failed to restore forward :${saved.localPort} → ${saved.remoteHost}:${saved.remotePort}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  persistSshPortForwardsWithUnrestored(dependencies, targetId)
}
