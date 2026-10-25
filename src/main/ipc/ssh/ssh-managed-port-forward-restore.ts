import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { getSshHostServerStatus, isSshHostServed } from '../../ssh/ssh-host-server-status'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { restorePortForwards, savedPortForwardsAllLive } from './ssh-port-forward-persistence'
import { forgetForwardFailures } from './ssh-port-forward-unrestored'
import { connectInFlight } from './ssh-connect-attempt-registry'

const changes = new Map<string, Promise<void>>()
/** The transport and time each host last restored on, so repeat triggers on it stay cheap. */
const restoredOn = new Map<string, { conn: SshConnection; generation: number; at: number }>()
// Each RPC triggers a restore; with system SSH every attempt is a new login, so pace them.
const RESTORE_MIN_INTERVAL_MS = 30_000

export type ManagedHostPortForwardRestoreOptions = {
  /** The managed server's tunnel is up, which proves the host is served even before a status lands. */
  tunnelUp?: boolean
}

function mayRestore(targetId: string, options: ManagedHostPortForwardRestoreOptions): boolean {
  const status = getSshHostServerStatus(targetId)
  // Unsettled hosts may still tear the transport down for a deploy or conversion.
  // A tunnel up with no status yet counts only outside a connect, whose decision may still redeploy.
  return (
    isSshHostServed(status) ||
    (options.tunnelUp === true && status === undefined && !connectInFlight.has(targetId))
  )
}

function alreadyRestored(targetId: string): boolean {
  const conn = connectionManager?.getConnection(targetId)
  const last = restoredOn.get(targetId)
  // A new transport restores at once: forwards on the old one reach nothing.
  if (!conn || last?.conn !== conn || last.generation !== conn.getConnectGeneration()) {
    return false
  }
  // Same transport: retry only for a forward that closed or failed since, and only after a pause.
  return Date.now() - last.at < RESTORE_MIN_INTERVAL_MS || savedPortForwardsAllLive(targetId)
}

/** Forgets a host's restore pacing and failures when its transport is torn down or it is removed. */
export function forgetPortForwardRestoreState(targetId: string): void {
  restoredOn.delete(targetId)
  forgetForwardFailures(targetId)
}

export function restoreManagedHostPortForwards(
  targetId: string,
  options: ManagedHostPortForwardRestoreOptions = {}
): Promise<void> {
  if (!mayRestore(targetId, options) || alreadyRestored(targetId)) {
    return Promise.resolve()
  }
  return serializePortForwardChange(targetId, async () => {
    // A queued disconnect or edit may have changed the host while earlier work ran.
    if (!mayRestore(targetId, options) || alreadyRestored(targetId)) {
      return
    }
    const conn = connectionManager?.getConnection(targetId)
    const generation = conn?.getConnectGeneration()
    const last = restoredOn.get(targetId)
    // A reconnect reuses the connection with a new generation; failures on the old one don't carry.
    if (last && (last.conn !== conn || last.generation !== generation)) {
      forgetForwardFailures(targetId)
    }
    await restorePortForwards(targetId, getCurrentMainWindow)
    if (conn && generation !== undefined && connectionManager?.getConnection(targetId) === conn) {
      restoredOn.set(targetId, { conn, generation, at: Date.now() })
    }
  }).catch((error: unknown) => {
    console.warn(`[ssh] Could not restore port forwards for ${targetId}:`, error)
  })
}

/**
 * Runs one change to a host's forwards after every earlier one. Restores and user edits share it,
 * so a restore can't bind a saved port twice or reopen a mapping an edit is replacing.
 */
export function serializePortForwardChange<T>(
  targetId: string,
  change: () => Promise<T>
): Promise<T> {
  const previous = changes.get(targetId) ?? Promise.resolve()
  const result = previous.then(change)
  const settled = result.then(
    () => {},
    () => {}
  )
  changes.set(targetId, settled)
  void settled.finally(() => {
    if (changes.get(targetId) === settled) {
      changes.delete(targetId)
    }
  })
  return result
}
