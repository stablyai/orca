import { readFileSync } from 'node:fs'
import { setLocalPtyProvider } from '../ipc/pty'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { getDaemonRuntimeDir as getRuntimeDir } from './daemon-launch-paths'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import type { DaemonProvider } from './daemon-provider-routing'
import { DaemonPtyRouter } from './daemon-pty-router'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import type { DaemonSpawner } from './daemon-spawner'
import {
  getMacDaemonTccAttributionHealth,
  type MacDaemonTccAttributionHealth
} from './daemon-tcc-attribution'
import { PROTOCOL_VERSION } from './types'

let spawner: DaemonSpawner | null = null
let adapter: DaemonProvider | null = null

export function installDaemonProvider(newSpawner: DaemonSpawner, newAdapter: DaemonProvider): void {
  spawner = newSpawner
  replaceDaemonProvider(newAdapter)
}

export function getDaemonSpawner(): DaemonSpawner | null {
  return spawner
}

// Why: a narrow getter (not a raw export) keeps the "swap on restart" invariant in one place (replaceDaemonProvider).
/**
 * Whether the installed provider is a daemon that will own FRESH terminals too.
 *
 * Why not `getDaemonProvider() !== null`: DegradedDaemonPtyProvider routes the daemon's
 * EXISTING sessions to the daemon but spawns new ones on the in-process local provider, so
 * those die with this process. A host that answered "I can recover persistent local PTYs"
 * from that state would be advertising recovery for terminals that cannot be recovered.
 */
export function daemonOwnsFreshPersistentPtys(): boolean {
  return adapter !== null && !(adapter instanceof DegradedDaemonPtyProvider)
}

/** Endpoint coordinates of the daemon this process installed, for out-of-band health probes. */
export type DaemonEndpointFacts = {
  runtimeDir: string
  socketPath: string
  tokenPath: string
  pidPath: string
  protocolVersion: number
}

export function getDaemonEndpointFacts(): DaemonEndpointFacts | null {
  if (!adapter) {
    return null
  }
  const runtimeDir = getRuntimeDir()
  return {
    runtimeDir,
    socketPath: getDaemonSocketPath(runtimeDir),
    tokenPath: getDaemonTokenPath(runtimeDir),
    pidPath: getDaemonPidPath(runtimeDir),
    protocolVersion: PROTOCOL_VERSION
  }
}

/**
 * What the live daemon's own PID record says about the build it was forked from.
 *
 * Why the record and not this process's version: the daemon deliberately outlives the
 * runtime, so after an update the two can legitimately disagree — and a health surface that
 * reported orcad's version for both would hide exactly that.
 */
export function readDaemonPidRecord(): ParsedDaemonPid | null {
  const facts = getDaemonEndpointFacts()
  if (!facts) {
    return null
  }
  try {
    return parseDaemonPidFile(readFileSync(facts.pidPath, 'utf8'))
  } catch {
    return null
  }
}

export function getDaemonProvider(): DaemonProvider | null {
  return adapter
}

// Why: computed from the pid record on demand (not cached at adoption) so the Settings
// remedy surface always reflects the daemon actually serving terminals right now.
export async function getCurrentDaemonMacTccAttributionHealth(): Promise<MacDaemonTccAttributionHealth> {
  const runtimeDir = getRuntimeDir()
  return getMacDaemonTccAttributionHealth(
    runtimeDir,
    getDaemonSocketPath(runtimeDir),
    getDaemonTokenPath(runtimeDir)
  )
}

/** Returns null unless every daemon generation supplied an authoritative inventory. */
export async function listLiveDaemonPtyIds(): Promise<string[] | null> {
  if (!adapter) {
    return null
  }
  const adapters =
    adapter instanceof DaemonPtyRouter || adapter instanceof DegradedDaemonPtyProvider
      ? adapter.getAllAdapters()
      : [adapter]
  const inventories = await Promise.allSettled(
    adapters.map((daemonAdapter) => daemonAdapter.listProcesses())
  )
  if (inventories.some((inventory) => inventory.status === 'rejected')) {
    return null
  }
  return inventories.flatMap((inventory) =>
    inventory.status === 'fulfilled' ? inventory.value.map((process) => process.id) : []
  )
}

// Why: keep the module-level adapter and ipc/pty.ts's localProvider in sync so app-quit can't dispose a stale reference.
export function replaceDaemonProvider(newAdapter: DaemonProvider): void {
  adapter = newAdapter
  setLocalPtyProvider(newAdapter)
}

// Disconnect without killing: the daemon survives app quit so sessions stay warm for reattach.
// Leave history sessions marked "unclean" so a daemon crash while Orca is closed stays recoverable.
export async function disconnectDaemon(): Promise<void> {
  await adapter?.disconnectOnly()
  adapter = null
}

/** Kill the daemon and all its sessions. Use for full cleanup only. */
export async function shutdownDaemon(): Promise<void> {
  adapter?.dispose()
  adapter = null
  await spawner?.shutdown()
  spawner = null
}
