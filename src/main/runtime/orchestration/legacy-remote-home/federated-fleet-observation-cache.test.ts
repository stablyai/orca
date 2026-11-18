import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { readCachedFederatedFleetSnapshots } from './federated-fleet-observation-cache'
import type { FederatedFleetRuntime } from './federated-fleet-snapshot'

let db: OrchestrationDb | null = null
afterEach(() => {
  vi.useRealTimers()
  db?.close()
  db = null
})

function startedOn(database: OrchestrationDb, dispatchId: string, environmentId: string): void {
  database.db
    .prepare(
      `INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version)
       VALUES (?, ?, ?, ?, 3)`
    )
    .run(dispatchId, environmentId, environmentId, `peer-${environmentId}`)
}

/** Every bot reads its own workers, one on each of `hosts`, all at once; reports the peak reads in flight. */
async function readAtOnce(bots: number, hosts: readonly string[]) {
  db = new OrchestrationDb(':memory:')
  const database = db
  const inFlight = new Map(hosts.map((host) => [host, 0]))
  let total = 0
  let peakTotal = 0
  let peakPerHost = 0
  const releases: (() => void)[] = []
  const runtime: FederatedFleetRuntime = {
    resolveOrchestrationWorkerServer: async (environmentId: string) => ({
      environmentId,
      name: environmentId,
      peerFingerprint: `peer-${environmentId}`,
      pairingRevision: 1
    }),
    callOrchestrationWorkerServer: async (environmentId: string) => {
      inFlight.set(environmentId, inFlight.get(environmentId)! + 1)
      total += 1
      peakTotal = Math.max(peakTotal, total)
      peakPerHost = Math.max(peakPerHost, inFlight.get(environmentId)!)
      await new Promise<void>((release) => releases.push(release))
      inFlight.set(environmentId, inFlight.get(environmentId)! - 1)
      total -= 1
      return { runtimeEpoch: `epoch-${environmentId}`, items: [] }
    }
  }
  const reads = Array.from({ length: bots }, (_, bot) => {
    const ids = hosts.map((host) => `ctx_${bot}_${host}`)
    ids.forEach((id, index) => startedOn(database, id, hosts[index]!))
    return readCachedFederatedFleetSnapshots({
      runtime,
      db: database,
      dispatchIds: ids,
      isOpen: () => true
    })
  })
  // Server lookups are async, so the first calls start a few ticks in: release until every read settles.
  let settled = false
  const all = Promise.all(reads).finally(() => {
    settled = true
  })
  while (!settled) {
    releases.splice(0).forEach((release) => release())
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const answered = await all
  return {
    peakTotal,
    peakPerHost,
    allAnswered: answered.every((snapshots) => snapshots?.hosts.size === hosts.length)
  }
}

describe('reading paired servers for many bots at once', () => {
  it('keeps one read in flight per server however many bots read', async () => {
    expect(await readAtOnce(40, ['env-a', 'env-b'])).toEqual({
      peakTotal: 2,
      peakPerHost: 1,
      allAnswered: true
    })
  })

  it('reads at most 4 servers at once, however many are paired', async () => {
    const hosts = Array.from({ length: 40 }, (_, index) => `env-${index}`)
    expect(await readAtOnce(1, hosts)).toEqual({
      peakTotal: 4,
      peakPerHost: 1,
      allAnswered: true
    })
  })

  it('gives an idle server its read within the deadline while 4 others are stuck', async () => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
    const database = db
    const hosts = ['env-stuck-0', 'env-stuck-1', 'env-stuck-2', 'env-stuck-3', 'env-idle']
    hosts.forEach((host) => startedOn(database, `ctx_${host}`, host))
    let idleAskedAt: number | null = null
    const runtime: FederatedFleetRuntime = {
      resolveOrchestrationWorkerServer: async (environmentId: string) => ({
        environmentId,
        name: environmentId,
        peerFingerprint: `peer-${environmentId}`,
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: (environmentId: string) => {
        if (environmentId !== 'env-idle') {
          // Waiting in its transport's queue, past any timeout it was given.
          return new Promise<never>(() => {})
        }
        idleAskedAt = Date.now()
        return Promise.resolve({ runtimeEpoch: 'epoch-idle', items: [] })
      }
    }
    const started = Date.now()
    const read = readCachedFederatedFleetSnapshots({
      runtime,
      db: database,
      dispatchIds: hosts.map((host) => `ctx_${host}`),
      isOpen: () => true
    })
    await vi.advanceTimersByTimeAsync(3_000)
    const snapshots = await read

    expect(idleAskedAt).not.toBeNull()
    expect(idleAskedAt! - started).toBeLessThanOrEqual(3_000)
    expect(snapshots?.errors.flatMap((error) => error.dispatchIds).sort()).toEqual(
      hosts.slice(0, 4).map((host) => `ctx_${host}`)
    )
  })
})
