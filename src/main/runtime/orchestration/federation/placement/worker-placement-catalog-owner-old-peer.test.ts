import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { WorkerPlacementCatalogOwner } from './worker-placement-catalog-owner'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { classifyWorkerPlacementCatalog } from './worker-placement-eligibility'

const server = {
  environmentId: 'server',
  name: 'server',
  peerFingerprint: 'peer',
  homePeerFingerprint: 'home',
  pairingRevision: 1
}
let db: OrchestrationDb
let root: string
let path: string
let response: (method: string) => Promise<RuntimeRpcResponse<unknown>>
let owner: WorkerPlacementCatalogOwner

function ok(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'read', ok: true, result, _meta: { runtimeId: 'peer' } }
}
async function complete(method: string): Promise<RuntimeRpcResponse<unknown>> {
  return method === 'repo.list'
    ? ok({ repos: [{ id: 'repo', path: '/server/repo', displayName: 'repo' }] })
    : ok({
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
      })
}
function oldPeerSetups(
  code: string,
  meta: { runtimeId: string | null } | undefined
): RuntimeRpcResponse<unknown> {
  return {
    id: 'read',
    ok: false,
    error: { code, message: 'old peer' },
    ...(meta ? { _meta: meta } : {})
  }
}
function transport(): OrchestrationEnvironmentTransport {
  return {
    list: async () => [{ environmentId: 'server', name: 'server' }],
    resolve: async () => ({ ...server }),
    call: (_id, method) => response(method)
  }
}
async function reopenWhileAsleep(): Promise<void> {
  db.close()
  db = new OrchestrationDb(path)
  owner = new WorkerPlacementCatalogOwner(db, transport())
  await vi.advanceTimersByTimeAsync(30_001)
  response = async () => {
    throw new Error('offline')
  }
}
function retainedRows(): unknown[] {
  return db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-20T20:00:00Z'))
  root = mkdtempSync(join(tmpdir(), 'orca-placement-old-peer-'))
  path = join(root, 'orchestration.db')
  db = new OrchestrationDb(path)
  response = complete
  owner = new WorkerPlacementCatalogOwner(db, transport())
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

it('marks a missing project API unsupported instead of projecting setups from repos', async () => {
  response = async (method) =>
    method === 'repo.list'
      ? await complete(method)
      : oldPeerSetups('method_not_found', { runtimeId: 'peer' })
  expect((await owner.discover())[0]).toMatchObject({ status: 'unsupported' })
  expect(retainedRows()).toEqual([])
})

it.each([
  { reply: 'a restarted runtime', code: 'method_not_found', meta: { runtimeId: 'restarted' } },
  { reply: 'a restarted runtime', code: 'incompatible_runtime', meta: { runtimeId: 'restarted' } },
  { reply: 'a reply without a runtime ID', code: 'method_not_found', meta: { runtimeId: null } },
  { reply: 'a reply without runtime metadata', code: 'method_not_found', meta: undefined }
])('keeps retention when the project API answers $code from $reply', async ({ code, meta }) => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = async (method) =>
    method === 'repo.list' ? await complete(method) : oldPeerSetups(code, meta)
  expect((await owner.discover())[0]).toMatchObject({
    status: 'retained',
    reason: 'incomplete',
    observedAt: 1795204800000
  })
  await reopenWhileAsleep()
  const snapshot = (await owner.discover())[0]
  expect(snapshot).toMatchObject({ status: 'retained', observedAt: 1795204800000 })
  if (snapshot.status === 'retained') {
    expect(classifyWorkerPlacementCatalog(snapshot.catalog)[0].explicitStart).toEqual({
      usable: true
    })
  }
})

it.each(['method_not_found', 'incompatible_runtime'])(
  'drops retention when the same runtime answers %s for the project API',
  async (code) => {
    await owner.discover()
    await vi.advanceTimersByTimeAsync(30_001)
    response = async (method) =>
      method === 'repo.list' ? await complete(method) : oldPeerSetups(code, { runtimeId: 'peer' })
    expect((await owner.discover())[0]).toMatchObject({ status: 'unsupported' })
    await reopenWhileAsleep()
    expect((await owner.discover())[0]).toMatchObject({ status: 'unchecked' })
    expect(retainedRows()).toEqual([])
  }
)
