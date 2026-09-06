import { readFileSync } from 'node:fs'
import { DaemonClient } from './client'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { readDaemonProcessIncarnation } from './daemon-ready-identity'
import type { DaemonPidFile, DaemonProcessHandle, DaemonSpawner } from './daemon-spawner'
import { replaceDaemonPidFile } from './daemon-spawner'

export class DaemonEndpointOwnershipError extends Error {}

/**
 * The one method the ownership checks need from a connected client.
 *
 * Why: naming the capability instead of casting DaemonClient to Partial keeps a rename from
 * silently turning the fence into a no-op — the compiler now rejects a client without it.
 */
type DaemonEndpointIdentityReader = {
  getDaemonIdentity?: () => DaemonEndpointIdentity | null
}

function readDaemonEndpointIdentity(
  client: DaemonEndpointIdentityReader
): DaemonEndpointIdentity | null {
  return client.getDaemonIdentity?.() ?? null
}

export async function holdDaemonAdoptionLease(
  handle: DaemonProcessHandle,
  socketPath: string,
  tokenPath: string,
  connectedClient?: DaemonClient,
  expectedIdentity?: DaemonEndpointIdentity,
  pidPath?: string
): Promise<DaemonProcessHandle> {
  const client = connectedClient ?? new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnected()
    if (expectedIdentity) {
      const actualIdentity = readDaemonEndpointIdentity(client)
      if (
        !actualIdentity ||
        actualIdentity.pid !== expectedIdentity.pid ||
        actualIdentity.startedAtMs !== expectedIdentity.startedAtMs ||
        actualIdentity.launchNonce !== expectedIdentity.launchNonce
      ) {
        throw new DaemonEndpointOwnershipError('Daemon endpoint ownership changed during startup')
      }
    }
    await reconcileDaemonPidOwnership(client, pidPath)
  } catch (error) {
    client.disconnect()
    throw error
  }
  handle.releaseAdoptionLease = () => client.disconnect()
  return handle
}

export async function reconcileDaemonPidOwnership(
  client: DaemonEndpointIdentityReader,
  pidPath?: string
): Promise<void> {
  const endpointIdentity = readDaemonEndpointIdentity(client)
  if (!pidPath || !endpointIdentity || pidRecordMatchesEndpoint(pidPath, endpointIdentity)) {
    return
  }
  // Why: the mismatched record's metadata describes a different daemon and must not be copied
  // onto this one. Re-derive it from the authenticated owner instead, so the repaired record
  // keeps the fields freshness, host pinning and pid-recycle detection depend on.
  const { pid, startedAtMs, launchNonce } = endpointIdentity
  const ownerMetadata = await readDaemonOwnerMetadata(endpointIdentity)
  if (!replaceDaemonPidFile(pidPath, { pid, startedAtMs, launchNonce, ...ownerMetadata })) {
    // Why: fail open. A record that disagrees with the endpoint is a diagnosable nuisance;
    // abandoning a healthy adoptable daemon over a failed file write costs the user every
    // persistent terminal on the machine.
    console.warn(
      '[daemon] Could not repair daemon PID ownership; adopting the authenticated endpoint anyway'
    )
    return
  }
  console.warn('[daemon] Repaired daemon PID ownership to match the authenticated endpoint')
}

/**
 * Recovers the owning daemon's launch metadata.
 *
 * Why: `entryPath`/`appVersion` gate bundle-freshness and (on Windows) which relocated daemon
 * host directories are pinned against pruning, and the Linux pair gates pid-recycle detection.
 * Publishing a repaired record without them makes a healthy daemon look permanently stale.
 * The values come from the authenticated hello rather than the owner's command line: a command
 * line is a single space-joined string, so any install path containing a space (`C:\Program
 * Files\...`, `/Applications/Orca 2.app/...`) cannot be split back into argv unambiguously.
 */
async function readDaemonOwnerMetadata(
  identity: DaemonEndpointIdentity
): Promise<Partial<DaemonPidFile>> {
  const metadata: Partial<DaemonPidFile> = {}
  if (identity.entryPath) {
    metadata.entryPath = identity.entryPath
  }
  if (identity.appVersion) {
    metadata.appVersion = identity.appVersion
  }
  if (identity.spawnerExecPath) {
    metadata.spawnerExecPath = identity.spawnerExecPath
  }
  const incarnation = await readDaemonProcessIncarnation(identity.pid)
  if (incarnation) {
    metadata.linuxStartTicks = incarnation.linuxStartTicks
    metadata.bootId = incarnation.bootId
  }
  return metadata
}

function pidRecordMatchesEndpoint(pidPath: string, identity: DaemonEndpointIdentity): boolean {
  try {
    const record = JSON.parse(readFileSync(pidPath, 'utf8')) as {
      pid?: unknown
      startedAtMs?: unknown
      launchNonce?: unknown
    }
    return (
      record.pid === identity.pid &&
      record.startedAtMs === identity.startedAtMs &&
      record.launchNonce === identity.launchNonce
    )
  } catch {
    return false
  }
}

export function releaseDaemonAdoptionLease(handle: DaemonProcessHandle | null): void {
  takeDaemonAdoptionLeaseRelease(handle)?.()
}

export function takeDaemonAdoptionLeaseRelease(
  handle: DaemonProcessHandle | null
): (() => void) | undefined {
  const release = handle?.releaseAdoptionLease
  if (!release || !handle) {
    return undefined
  }
  delete handle.releaseAdoptionLease
  return release
}

export async function cleanupFailedDaemonAdoption(
  failedSpawner: DaemonSpawner,
  current: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[] = []
): Promise<void> {
  const handle = failedSpawner.getHandle()
  const results = await Promise.allSettled([
    Promise.resolve().then(() => releaseDaemonAdoptionLease(handle)),
    ...legacy.map((entry) => entry.disconnectOnly()),
    (async () => {
      try {
        // Why: other authenticated clients may win, so only daemon-side shutdownIfIdle can prove a failed adoption is killable.
        await current.disconnectOnly()
      } catch (error) {
        current.dispose()
        throw error
      }
    })()
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Daemon adoption cleanup failed')
  }
}
