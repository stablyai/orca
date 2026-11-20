import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { WorkerPlacementCatalogOwner } from './worker-placement-catalog-owner'
import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { classifyWorkerPlacementCatalog } from './worker-placement-eligibility'

let db: OrchestrationDb
let root: string
let path: string
let server: OrchestrationWorkerServer
let list: { environmentId: string; name: string }[]
let notify: (() => void) | undefined
let response: (method: string) => Promise<RuntimeRpcResponse<unknown>>
let owner: WorkerPlacementCatalogOwner

function ok(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'read', ok: true, result, _meta: { runtimeId: 'peer' } }
}
function complete(method: string): Promise<RuntimeRpcResponse<unknown>> {
  return Promise.resolve(
    ok(
      method === 'repo.list'
        ? { repos: [{ id: 'repo', path: '/server/repo', displayName: 'repo' }] }
        : {
            setups: [
              {
                id: 'setup',
                projectId: 'github:team/repo',
                repoId: 'repo',
                hostId: 'local',
                path: '/server/repo',
                displayName: 'repo',
                setupState: 'ready',
                workerExecutionTarget: { kind: 'native' }
              }
            ]
          }
    )
  )
}
function transport(): OrchestrationEnvironmentTransport {
  return {
    list: async () => list,
    resolve: async () => {
      if (!list.length) {
        throw new Error('removed')
      }
      return { ...server }
    },
    call: (_id, method) => response(method),
    onCatalogChanged: (listener) => {
      notify = listener
      return () => {
        notify = undefined
      }
    }
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-20T20:00:00Z'))
  root = mkdtempSync(join(tmpdir(), 'orca-placement-'))
  path = join(root, 'orchestration.db')
  db = new OrchestrationDb(path)
  server = {
    environmentId: 'server',
    name: 'server',
    peerFingerprint: 'peer',
    homePeerFingerprint: 'home',
    pairingRevision: 1
  }
  list = [{ environmentId: 'server', name: 'server' }]
  response = complete
  owner = new WorkerPlacementCatalogOwner(db, transport())
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

it('retains a complete sleeping-server catalog across database restart', async () => {
  expect((await owner.discover())[0]).toMatchObject({ status: 'fresh', observedAt: 1795204800000 })
  db.close()
  db = new OrchestrationDb(path)
  owner = new WorkerPlacementCatalogOwner(db, transport())
  await vi.advanceTimersByTimeAsync(30_001)
  response = async () => {
    throw new Error('offline')
  }
  const snapshot = (await owner.discover())[0]
  expect(snapshot).toMatchObject({ status: 'retained', observedAt: 1795204800000 })
  if (snapshot.status === 'retained') {
    expect(classifyWorkerPlacementCatalog(snapshot.catalog)[0].explicitStart).toEqual({
      usable: true
    })
  }
})

it.each(['peerFingerprint', 'homePeerFingerprint', 'pairingRevision'] as const)(
  'drops retention when %s changes',
  async (field) => {
    await owner.discover()
    if (field === 'pairingRevision') {
      server.pairingRevision = 2
    } else {
      server[field] = 'changed'
    }
    response = async () => {
      throw new Error('offline')
    }
    expect((await owner.discover())[0]).toMatchObject({ status: 'unchecked', reason: 'no_answer' })
    expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
  }
)

it('deletes removed-pairing retention without another discovery call', async () => {
  await owner.discover()
  list = []
  notify!()
  await vi.advanceTimersByTimeAsync(0)
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it('never replaces retained data with an incomplete or oversized pair', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = async (method) =>
    method === 'repo.list' ? ok({ repos: Array(5_001).fill(null) }) : await complete(method)
  expect((await owner.discover())[0]).toMatchObject({ status: 'retained', reason: 'oversized' })
  response = async (method) =>
    method === 'repo.list' ? ok({ repos: [{ id: 7 }] }) : await complete(method)
  expect((await owner.discover())[0]).toMatchObject({ status: 'retained', reason: 'incomplete' })
  response = async (method) => {
    if (method === 'repo.list') {
      throw new Error('one list failed')
    }
    return complete(method)
  }
  expect((await owner.discover())[0]).toMatchObject({ status: 'retained', reason: 'incomplete' })
  expect(db.db.prepare('SELECT observed_at FROM worker_placement_catalogs').get()).toEqual({
    observed_at: 1795204800000
  })
})

it('a late complete reply updates retention without changing the completed discovery', async () => {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  response = async (method) => {
    await wait
    return complete(method)
  }
  const pending = owner.discover()
  await vi.advanceTimersByTimeAsync(5_000)
  const answer = await pending
  expect(answer[0]).toMatchObject({ status: 'unchecked', reason: 'no_answer' })
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect((await owner.discover())[0]).toMatchObject({ status: 'fresh', observedAt: 1795204805000 })
  expect(answer[0]).toMatchObject({ status: 'unchecked' })
})

it.each(['removed', 'repaired'] as const)(
  'discards replies arriving after the pairing was %s',
  async (change) => {
    let finish!: () => void
    const wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    response = async (method) => {
      await wait
      return complete(method)
    }
    const pending = owner.discover()
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    if (change === 'removed') {
      list = []
    } else {
      server = { ...server, pairingRevision: 2, homePeerFingerprint: 'new-home' }
    }
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
  }
)

it('replaces native evidence with a complete older reply and preserves its registration after restart', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = async (method) =>
    method === 'repo.list'
      ? await complete(method)
      : ok({
          setups: [
            {
              id: 'setup',
              projectId: 'github:team/repo',
              repoId: 'repo',
              hostId: 'local',
              path: '/server/repo',
              displayName: 'repo',
              setupState: 'ready'
            }
          ]
        })
  await owner.discover()
  db.close()
  db = new OrchestrationDb(path)
  owner = new WorkerPlacementCatalogOwner(db, transport())
  const snapshot = (await owner.discover())[0]
  expect(snapshot.status).toBe('fresh')
  if (snapshot.status === 'fresh') {
    expect(classifyWorkerPlacementCatalog(snapshot.catalog)[0]).toMatchObject({
      classification: 'registered_not_usable',
      explicitStart: { usable: false, reason: 'unsupported_target' }
    })
  }
})

it('marks a missing project API unsupported instead of projecting setups from repos', async () => {
  response = async (method) =>
    method === 'repo.list'
      ? await complete(method)
      : {
          id: 'read',
          ok: false,
          error: { code: 'method_not_found', message: 'old peer' },
          _meta: { runtimeId: 'peer' }
        }
  expect((await owner.discover())[0]).toMatchObject({ status: 'unsupported' })
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it('upgrades a v49 database with only this slice’s additive catalog table', async () => {
  db.db.exec('DROP TABLE worker_placement_catalogs')
  db.db.pragma('user_version = 49')
  db.close()
  db = new OrchestrationDb(path)
  owner = new WorkerPlacementCatalogOwner(db, transport())
  expect(db.db.pragma('user_version', { simple: true })).toBe(50)
  expect((await owner.discover())[0]).toMatchObject({ status: 'fresh' })
})
