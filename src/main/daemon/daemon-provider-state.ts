import { setLocalPtyProvider } from '../ipc/pty/provider/registry'
import { setLocalDaemonPidReader } from '../memory/local-daemon-pid'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { DaemonPtyRouter } from './daemon-pty-router'
import { getDaemonRuntimeDir as getRuntimeDir } from './daemon-launch-paths'
import { readDaemonPidRecord as readDaemonPidRecordAt } from './daemon-endpoint-incarnation'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import {
  getCurrentDaemonAdapter,
  getLegacyDaemonAdapters,
  listEveryDaemonGeneration,
  type DaemonProvider
} from './daemon-provider-routing'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import type { DaemonSpawner } from './daemon-spawner'
import {
  getMacDaemonTccAttributionHealth,
  type MacDaemonTccAttributionHealth
} from './daemon-tcc-attribution'
import { PROTOCOL_VERSION, type DaemonSessionInfo, type SessionInfo } from './types'
import type { DaemonIdleRetirementResult } from './daemon-pty-runtime-state'

let spawner: DaemonSpawner | null = null
let adapter: DaemonProvider | null = null

export function installDaemonProvider(
  newSpawner: DaemonSpawner | null,
  newAdapter: DaemonProvider
): void {
  spawner = newSpawner
  replaceDaemonProvider(newAdapter)
  setLocalDaemonPidReader(() => readDaemonPidRecord()?.pid ?? null)
}

export function getDaemonSpawner(): DaemonSpawner | null {
  return spawner
}

/** Degraded providers keep existing sessions persistent but spawn fresh terminals in-process. */
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

/** Read the daemon's build from its record: it may outlive the app version now running. */
export function readDaemonPidRecord(): ParsedDaemonPid | null {
  return readDaemonPidRecordAt(getDaemonEndpointFacts()?.pidPath ?? null)
}

export function getDaemonProvider(): DaemonProvider | null {
  return adapter
}

/** True for a terminal on a kept-alive older daemon whose protocol matches; never for an SSH pane. */
export function isTerminalOnLegacyDaemon(
  ptyId: string,
  matches: (protocolVersion: number) => boolean
): boolean {
  return adapter
    ? getLegacyDaemonAdapters(adapter).some(
        (legacy) => matches(legacy.protocolVersion) && legacy.hasPty(ptyId)
      )
    : false
}

// Read attribution on demand so Settings describes the daemon currently serving terminals.
export async function getCurrentDaemonMacTccAttributionHealth(): Promise<MacDaemonTccAttributionHealth> {
  const runtimeDir = getRuntimeDir()
  return getMacDaemonTccAttributionHealth(
    runtimeDir,
    getDaemonSocketPath(runtimeDir),
    getDaemonTokenPath(runtimeDir)
  )
}

// Keep module state and the quit-time provider reference in sync.
export function replaceDaemonProvider(newAdapter: DaemonProvider): void {
  adapter = newAdapter
  setLocalPtyProvider(newAdapter)
}

// Preserve warm sessions and unclean history so crashes while Orca is closed remain recoverable.
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

/** Returns null unless every daemon generation supplied an authoritative inventory. */
export async function listLiveDaemonPtyIds(): Promise<string[] | null> {
  return adapter
    ? listEveryDaemonGeneration(adapter, async (a) => (await a.listProcesses()).map((p) => p.id))
    : null
}

/** Returns null unless every daemon generation supplied an authoritative session inventory. */
export async function listLiveDaemonSessions(): Promise<SessionInfo[] | null> {
  const sessions = await listLiveDaemonSessionsWithProtocol()
  return sessions?.map(({ protocolVersion: _protocolVersion, ...session }) => session) ?? null
}

/** Like listLiveDaemonSessions, with the protocol of the daemon generation owning each session. */
export async function listLiveDaemonSessionsWithProtocol(): Promise<DaemonSessionInfo[] | null> {
  return adapter
    ? listEveryDaemonGeneration(adapter, async (a) =>
        (await a.listSessions()).map((session) => ({
          ...session,
          protocolVersion: a.protocolVersion
        }))
      )
    : null
}

/** Terminals the degraded provider ran in-process; none outside degraded mode. */
export async function countInProcessFallbackTerminals(): Promise<number> {
  return adapter instanceof DegradedDaemonPtyProvider
    ? (await adapter.fallback.listProcesses()).length
    : 0
}

/** Atomically fence new daemon terminals and retire only an idle, single-generation daemon. */
export async function requestIdleDaemonRetirement(): Promise<DaemonIdleRetirementResult> {
  if (!adapter) {
    return { state: 'unverifiable' }
  }
  if (adapter instanceof DegradedDaemonPtyProvider) {
    return { state: 'unverifiable' }
  }
  return adapter.requestIdleRetirement()
}

/** Whether an idle-retirement attempt left the daemon refusing new terminals. */
export function isDaemonTerminalAdmissionClosed(): boolean {
  if (!adapter || adapter instanceof DegradedDaemonPtyProvider) {
    return false
  }
  // Fresh terminals go to the current generation, behind the router's own fence.
  return (
    (adapter instanceof DaemonPtyRouter && adapter.retirement.admissionClosed) ||
    getCurrentDaemonAdapter(adapter).isIdleRetirementAdmissionClosed()
  )
}

/** The pid the current daemon generation last authenticated as, if it ever did. */
export function getCurrentDaemonPid(): number | null {
  return adapter && !(adapter instanceof DegradedDaemonPtyProvider)
    ? (getCurrentDaemonAdapter(adapter).getLastAuthenticatedDaemonIdentity()?.pid ?? null)
    : null
}

/** Reopens terminal admission when an idle-retirement attempt did not retire the daemon. */
export function releaseDaemonRetirementFence(): void {
  if (adapter && !(adapter instanceof DegradedDaemonPtyProvider)) {
    adapter.releaseIdleRetirementFence()
  }
}
