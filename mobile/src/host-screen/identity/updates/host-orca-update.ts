import { useSyncExternalStore } from 'react'
import type {
  RemoteServerUpdateRestartImpact,
  RemoteServerUpdaterSnapshot
} from '../../../../../src/shared/remote-runtime/host-catalog/remote-server-update'
import {
  downloadRemoteServerUpdate,
  installRemoteServerUpdate,
  type RemoteServerUpdateStageTransport
} from '../../../../../src/shared/remote-runtime/host-updates/remote-server-update-stages'
import type {
  RemoteServerUpdateEntry,
  RemoteServerUpdateTiming
} from '../../../../../src/shared/remote-runtime/host-updates/remote-server-update-entry'
import { RemoteServerUpdaterStatusError } from '../../../../../src/shared/remote-runtime/host-updates/remote-server-updater-polling'
import type { HostClientAcquisition } from '../../../transport/connection/host-client-acquisition-registry'
import type { RpcClientContextValue } from '../../../transport/connection/rpc-client-context-contract'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  updaterCheck,
  updaterDownload,
  updaterInstall,
  updaterRestartImpactRead,
  updaterStatusRead
} from './host-orca-update-operations'
import { offeredOrcaVersion, sameSnapshot } from './host-orca-update-snapshot'

export type HostOrcaRestartImpact =
  | { state: 'loading' }
  | { state: 'ready'; impact: RemoteServerUpdateRestartImpact }
  // The host didn't say; the confirm must not read as "nothing stops".
  | { state: 'unknown' }

/** One computer's Orca update as the phone follows it; kept while the app runs, so Hide never stops it. */
export type HostOrcaUpdate = {
  /** The computer's updater as last read. */
  snapshot: RemoteServerUpdaterSnapshot | null
  /** The update the phone is running or ran, from Download to back online. */
  entry: RemoteServerUpdateEntry | null
  impact: HostOrcaRestartImpact | null
  /** A stage is in flight; a second tap does nothing. */
  busy: boolean
}

// A phone polls gently: once a second is enough to move a progress bar and see the restart.
const PHONE_UPDATE_TIMING: RemoteServerUpdateTiming = {
  operationTimeoutMs: 10 * 60 * 1000,
  reconnectTimeoutMs: 3 * 60 * 1000,
  pollIntervalMs: 1000
}
const STATUS_READ_TIMEOUT_MS = 15_000
const EMPTY: HostOrcaUpdate = { snapshot: null, entry: null, impact: null, busy: false }

// The restart wait reads status and then asks why the old process failed; one read serves both.
const SAME_TICK_MS = 250

const hosts = new Map<string, HostOrcaUpdate>()
const listeners = new Set<() => void>()
// One token per computer in use; work for a removed computer holds an old token and writes nothing.
/** Identity only: compared by reference, never read. */
type HostOrcaUpdateOwner = Record<string, never>
const owners = new Map<string, HostOrcaUpdateOwner>()
// Restart-impact reads per computer in use; goes with its owner.
const impactReads = new WeakMap<HostOrcaUpdateOwner, number>()

function ownerOf(hostId: string): HostOrcaUpdateOwner {
  let owner = owners.get(hostId)
  if (!owner) {
    owner = {}
    owners.set(hostId, owner)
  }
  return owner
}

function write(
  hostId: string,
  next: (update: HostOrcaUpdate) => HostOrcaUpdate,
  owner: HostOrcaUpdateOwner = ownerOf(hostId)
): void {
  if (owners.get(hostId) !== owner) {
    return
  }
  const current = hosts.get(hostId) ?? EMPTY
  const updated = next(current)
  if (updated !== current) {
    hosts.set(hostId, updated)
    listeners.forEach((listener) => listener())
  }
}

const read = (hostId: string): HostOrcaUpdate => hosts.get(hostId) ?? EMPTY

function connectedClient(connections: RpcClientContextValue, hostId: string): RpcClient {
  const client = connections.getAllClients().find((entry) => entry.hostId === hostId)?.client
  if (!client) {
    throw new Error('host_not_connected')
  }
  return client
}

async function readSnapshot(
  client: RpcClient,
  timeoutMs: number
): Promise<RemoteServerUpdaterSnapshot> {
  // A restart drops the socket; the read waits for the reconnect inside its own budget.
  const reply = await updaterStatusRead.request(client, undefined, {
    timeoutMs,
    budgetSpansConnect: true
  })
  return updaterStatusRead.interpret(reply)
}

function stageTransport(
  connections: RpcClientContextValue,
  hostId: string,
  owner: HostOrcaUpdateOwner
): RemoteServerUpdateStageTransport {
  const client = () => connectedClient(connections, hostId)
  let last: { snapshot: RemoteServerUpdaterSnapshot; at: number } | null = null
  return {
    getRuntimeStatus: async (_id, timeoutMs, options) => {
      const live = client()
      // The restart wait asks for the new process now, not after the reconnect backoff.
      if (options?.force && live.getState() !== 'connected') {
        live.notifyForeground('focus')
      }
      const snapshot = await readSnapshot(live, timeoutMs ?? STATUS_READ_TIMEOUT_MS)
      last = { snapshot, at: Date.now() }
      return { runtimeId: snapshot.runtimeId, appVersion: snapshot.appVersion }
    },
    getUpdaterStatus: (_id, timeoutMs) =>
      last && Date.now() - last.at < SAME_TICK_MS
        ? Promise.resolve(last.snapshot)
        : readSnapshot(client(), timeoutMs ?? STATUS_READ_TIMEOUT_MS),
    check: async (_id, options) =>
      updaterCheck.interpret(await updaterCheck.request(client(), options)),
    download: async () => updaterDownload.interpret(await updaterDownload.request(client())),
    install: async () => updaterInstall.interpret(await updaterInstall.request(client())),
    // A removed computer ends the stage at its next tick instead of polling out its deadline.
    wait: (milliseconds) =>
      new Promise((resolve, reject) =>
        setTimeout(
          () => (owners.get(hostId) === owner ? resolve() : reject(new Error('host_removed'))),
          milliseconds
        )
      ),
    // The host words its own updater failures; other codes are worded by the sheet.
    describeError: (error) =>
      error instanceof RemoteServerUpdaterStatusError
        ? error.status.message
        : error instanceof Error
          ? error.message
          : String(error)
  }
}

/** Reads where the computer's updater stands, as Edit computer opens; never starts a check there. */
export async function readHostOrcaUpdate(client: RpcClient, hostId: string): Promise<void> {
  const owner = ownerOf(hostId)
  try {
    const snapshot = await readSnapshot(client, STATUS_READ_TIMEOUT_MS)
    // Reopening Edit computer on an unchanged computer publishes nothing.
    write(
      hostId,
      (update) => (sameSnapshot(update.snapshot, snapshot) ? update : { ...update, snapshot }),
      owner
    )
  } catch {
    // An older host or a dropped read keeps the last answer; the row then shows the version alone.
  }
}

function startEntry(
  hostId: string,
  name: string,
  snapshot: RemoteServerUpdaterSnapshot
): RemoteServerUpdateEntry {
  return {
    environmentId: hostId,
    name,
    phase: 'available',
    currentVersion: snapshot.appVersion,
    targetVersion: offeredOrcaVersion(snapshot),
    progress: null,
    runtimeId: snapshot.runtimeId,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: snapshot.support,
    error: null
  }
}

/** Holds the computer's connection while a stage runs, so leaving Edit computer never drops the update. */
async function runStage(
  connections: RpcClientContextValue,
  hostId: string,
  stage: (transport: RemoteServerUpdateStageTransport) => Promise<RemoteServerUpdateEntry>
): Promise<RemoteServerUpdateEntry | null> {
  if (read(hostId).busy) {
    return null
  }
  const owner = ownerOf(hostId)
  const holder: HostClientAcquisition = {}
  connections.acquire(hostId, holder)
  write(hostId, (update) => ({ ...update, busy: true }), owner)
  try {
    return await stage(stageTransport(connections, hostId, owner))
  } finally {
    connections.release(hostId, holder)
    write(hostId, (update) => ({ ...update, busy: false }), owner)
  }
}

// A fresh try asks for its own restart; only "Check again" reuses the one already accepted.
function withoutInstall(entry: RemoteServerUpdateEntry): RemoteServerUpdateEntry {
  const { install: _accepted, ...rest } = entry
  return rest
}

const onProgress =
  (hostId: string, owner: HostOrcaUpdateOwner) => (entry: RemoteServerUpdateEntry) =>
    write(hostId, (update) => ({ ...update, entry }), owner)

/** Downloads the offered update, or follows one already downloading; then reads what a restart stops. */
export async function downloadHostOrcaUpdate(
  connections: RpcClientContextValue,
  hostId: string,
  name: string
): Promise<void> {
  const owner = ownerOf(hostId)
  const { entry, snapshot: known } = read(hostId)
  if (!known) {
    return
  }
  const downloaded = await runStage(connections, hostId, async (transport) => {
    // Another client may have started or finished the download since the screen read it.
    let snapshot = known
    try {
      snapshot = await transport.getUpdaterStatus(hostId, STATUS_READ_TIMEOUT_MS)
      const fresh = snapshot
      write(hostId, (update) => ({ ...update, snapshot: fresh }), owner)
    } catch {
      // The stage itself reports a computer it can't reach.
    }
    const start =
      entry?.phase === 'failed'
        ? { ...withoutInstall(entry), name }
        : startEntry(hostId, name, snapshot)
    return downloadRemoteServerUpdate(start, transport, onProgress(hostId, owner), {
      // A state the coordinator can't resume from (idle, error) checks again first.
      from: snapshot,
      timing: PHONE_UPDATE_TIMING
    })
  })
  if (downloaded?.phase !== 'downloaded') {
    return
  }
  write(hostId, (update) => ({ ...update, entry: downloaded }), owner)
  await refreshHostOrcaRestartImpact(connections, hostId, owner)
}

/** Reads again what a restart would stop, right before the confirm is shown. */
export async function refreshHostOrcaRestartImpact(
  connections: RpcClientContextValue,
  hostId: string,
  owner: HostOrcaUpdateOwner = ownerOf(hostId)
): Promise<void> {
  // A download that finished as its computer was removed brings nothing back into the store.
  if (owners.get(hostId) !== owner) {
    return
  }
  const readNumber = (impactReads.get(owner) ?? 0) + 1
  impactReads.set(owner, readNumber)
  // Only the newest read decides; an older one landing late never reopens the confirm on its list.
  const latest = (update: HostOrcaUpdate, next: HostOrcaRestartImpact): HostOrcaUpdate =>
    impactReads.get(owner) === readNumber ? { ...update, impact: next } : update
  // Restart stays off until this read lands, so it never confirms against an older list.
  write(hostId, (update) => ({ ...update, impact: { state: 'loading' } }), owner)
  try {
    const client = connectedClient(connections, hostId)
    const impact = updaterRestartImpactRead.interpret(
      await updaterRestartImpactRead.request(client, undefined, {
        timeoutMs: STATUS_READ_TIMEOUT_MS
      })
    )
    write(hostId, (update) => latest(update, { state: 'ready', impact }), owner)
  } catch {
    write(hostId, (update) => latest(update, { state: 'unknown' }), owner)
  }
}

/** Restarts the computer onto its downloaded update, only after the confirm; or waits again for one. */
export async function restartHostOrcaUpdate(
  connections: RpcClientContextValue,
  hostId: string
): Promise<void> {
  const owner = ownerOf(hostId)
  const { entry } = read(hostId)
  if (!entry || (entry.phase !== 'downloaded' && !entry.install)) {
    return
  }
  const updated = await runStage(connections, hostId, (transport) =>
    installRemoteServerUpdate(entry, transport, onProgress(hostId, owner), {
      timing: PHONE_UPDATE_TIMING,
      // A restart already asked for is waited for again, never asked for twice.
      ...(entry.install ? { install: entry.install } : {})
    })
  )
  if (updated?.phase === 'updated') {
    const client = connections.getAllClients().find((item) => item.hostId === hostId)?.client
    if (client) {
      void readHostOrcaUpdate(client, hostId)
    }
  }
}

/** Forgets a removed computer. */
export function forgetHostOrcaUpdate(hostId: string): void {
  owners.delete(hostId)
  if (hosts.delete(hostId)) {
    listeners.forEach((listener) => listener())
  }
}

/** Forgets a finished or failed update once its sheet closes; a running one keeps going. */
export function settleHostOrcaUpdate(hostId: string): void {
  write(hostId, (update) =>
    update.busy || !update.entry || update.entry.phase !== 'updated'
      ? update
      : { ...update, entry: null, impact: null }
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The version a restart the phone asked for is heading to, while the computer is away. */
export function useHostOrcaRestartingTo(hostId: string): string | null {
  const restartingTo = (): string | null => {
    const entry = read(hostId).entry
    return entry?.phase === 'restarting' ? entry.targetVersion : null
  }
  return useSyncExternalStore(subscribe, restartingTo, restartingTo)
}

export function useHostOrcaUpdate(hostId: string): HostOrcaUpdate {
  const snapshot = (): HostOrcaUpdate => read(hostId)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
