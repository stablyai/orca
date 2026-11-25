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
import { pairedOrchestrationPeers } from '../environment-transport'
import type { PairedRuntimeConnection } from '../../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type {
  RuntimeRequestGuard,
  RuntimeRpcResponse
} from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { prepareCurrentRuntimeRequest } from '../../../../../shared/remote-runtime/requests/remote-runtime-request-preparation'
import { classifyWorkerPlacementCatalog } from './worker-placement-eligibility'
import { OrchestrationError } from '../../orchestration-error'
import * as environmentStore from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'

let db: OrchestrationDb
let root: string
let path: string
let server: OrchestrationWorkerServer
let list: { environmentId: string; name: string }[]
let notify: (() => void) | undefined
let response: (method: string) => Promise<RuntimeRpcResponse<unknown>>
let owner: WorkerPlacementCatalogOwner
let registry: OrchestrationEnvironmentTransport
const catalogConnection: PairedRuntimeConnection = {
  endpoint: 'ws://server',
  hostPublicKeyB64: Buffer.from('server-key').toString('base64'),
  credential: { kind: 'token', deviceToken: 'home-token' }
}

async function pendingCatalogGuard() {
  server = {
    ...server,
    ...pairedOrchestrationPeers(catalogConnection.hostPublicKeyB64, 'home-token')
  }
  let capture!: (guard: RuntimeRequestGuard) => void
  const captured = new Promise<RuntimeRequestGuard>((resolve) => {
    capture = resolve
  })
  registry.call = async (_id, _method, _params, _timeout, _envelope, _revision, options) => {
    capture(options!.prepareGuard!)
    return await new Promise(() => {})
  }
  const discovery = owner.discover('server')
  return { guard: await captured, discovery }
}

function prepareCatalogRequest(guard: RuntimeRequestGuard, consume: () => void) {
  return prepareCurrentRuntimeRequest({
    connection: catalogConnection,
    guard,
    current: () => true,
    deadline: Infinity,
    expire: () => {
      throw new Error('Unexpected transport expiry')
    },
    consume
  })
}

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
    listSavedEnvironmentIds: async () => list.map(({ environmentId }) => environmentId),
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
  registry = transport()
  owner = new WorkerPlacementCatalogOwner(db, registry)
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
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

it('deletes removed-pairing retention when a notification arrives during a failed reconciliation', async () => {
  await owner.discover()
  const read = Promise.withResolvers<typeof list>()
  registry.list = vi.fn(() => Promise.resolve(list)).mockReturnValueOnce(read.promise)
  notify!()
  await vi.advanceTimersByTimeAsync(0)
  list = []
  notify!()
  read.reject(new Error('Registry unavailable.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it('preserves sleeping-server retention when an empty enumeration straddles pairing restoration', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = async () => {
    throw new Error('offline')
  }
  const read = Promise.withResolvers<typeof list>()
  registry.list = vi.fn(() => Promise.resolve(list)).mockReturnValueOnce(read.promise)
  const pairing = list
  list = []
  notify!()
  const discovery = owner.discover()
  await vi.advanceTimersByTimeAsync(0)
  const captured = list
  list = pairing
  notify!()
  read.resolve(captured)
  await vi.advanceTimersByTimeAsync(0)
  expect(await discovery).toMatchObject([{ status: 'retained', observedAt: 1795204800000 }])
  expect(await owner.discover()).toMatchObject([{ status: 'retained', observedAt: 1795204800000 }])
})

it('rejects the display-name fallback for a requested environment ID', async () => {
  registry.resolve = async () => ({ ...server, environmentId: 'other', name: 'server' })
  expect(await owner.discover('server')).toMatchObject([
    { server: { environmentId: 'server' }, status: 'unchecked', reason: 'no_answer' }
  ])
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

it('ends discovery when registry enumeration stalls', async () => {
  registry.list = () => new Promise(() => {})
  const discovery = expect(owner.discover()).rejects.toMatchObject({
    code: 'runtime_timeout',
    data: { effectsApplied: false, reason: 'discovery_incomplete', phase: 'registry' }
  })
  await vi.advanceTimersByTimeAsync(5_000)
  await discovery
})

it('returns an empty discovery only after successfully enumerating an empty registry', async () => {
  list = []
  expect(await owner.discover()).toEqual([])
})

it('preserves a typed registry failure without reporting absence', async () => {
  await vi.advanceTimersByTimeAsync(0)
  const error = new OrchestrationError('runtime_environment_changed', 'Pairing registry changed.')
  registry.list = async () => {
    throw error
  }
  await expect(owner.discover()).rejects.toBe(error)
})

it.each([
  undefined,
  vi.fn().mockResolvedValue(undefined),
  vi.fn().mockRejectedValue(new Error('offline'))
])('rejects an incomplete registry enumeration without reporting absence', async (list) => {
  await vi.advanceTimersByTimeAsync(0)
  registry.list = list
  await expect(owner.discover()).rejects.toMatchObject({
    code: 'runtime_error',
    data: { effectsApplied: false, reason: 'discovery_incomplete', phase: 'registry' }
  })
})

it('does not read servers from a registry enumeration completed after discovery expired', async () => {
  let finish!: (value: typeof list) => void
  registry.list = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const discovery = expect(owner.discover()).rejects.toMatchObject({ code: 'runtime_timeout' })
  await vi.advanceTimersByTimeAsync(5_000)
  await discovery
  finish(list)
  await vi.advanceTimersByTimeAsync(0)
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it('returns unchecked when initial pairing resolution stalls even with a retained catalog', async () => {
  await owner.discover()
  registry.resolve = () => new Promise(() => {})
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
  expect(db.db.prepare('SELECT observed_at FROM worker_placement_catalogs').get()).toEqual({
    observed_at: 1795204800000
  })
})

it('returns unchecked when final snapshot validation cannot establish the current pairing', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  registry.resolve = vi
    .fn()
    .mockResolvedValueOnce({ ...server })
    .mockResolvedValueOnce({ ...server })
    .mockImplementation(() => new Promise(() => {}))
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
})

it('keeps valid retention at the soft deadline while the current full pin remains proven', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = () => new Promise(() => {})
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([
    {
      status: 'retained',
      reason: 'no_answer',
      observedAt: 1795204800000
    }
  ])
})

it('returns unchecked at the soft deadline when the proven pairing generation changed', async () => {
  let generation = 0
  vi.spyOn(environmentStore, 'environmentStoreWriteCount').mockImplementation(() => generation)
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = () => new Promise(() => {})
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(0)
  generation = 1
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
})

it.each(['removed', 'repaired'] as const)(
  'invalidates captured retention after an external pairing is %s through the registry watcher',
  async (change) => {
    await owner.discover()
    await vi.advanceTimersByTimeAsync(30_001)
    let finish!: () => void
    const wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    response = async (method) => {
      await wait
      return complete(method)
    }
    const discovery = owner.discover('server')
    await vi.advanceTimersByTimeAsync(0)
    if (change === 'removed') {
      list = []
    } else {
      server = {
        ...server,
        peerFingerprint: 'new-peer',
        homePeerFingerprint: 'new-home',
        pairingRevision: 2
      }
    }
    notify!()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
  }
)

it('keeps sleeping-server retention when the watcher re-establishes the unchanged full pairing', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = () => new Promise(() => {})
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(0)
  notify!()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([
    { status: 'retained', reason: 'no_answer', observedAt: 1795204800000 }
  ])
})

it('fails closed when watcher reconciliation cannot re-establish a captured pairing', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  response = () => new Promise(() => {})
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(0)
  registry.resolve = () => new Promise(() => {})
  notify!()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
})

it('rejects an initial pairing proof that straddles an external registry change', async () => {
  await owner.discover()
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  registry.resolve = async () => {
    const captured = { ...server }
    await wait
    return captured
  }
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(0)
  list = []
  notify!()
  await vi.advanceTimersByTimeAsync(0)
  finish()
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it('rejects persistence proof that straddles an external re-pair', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  let validating = false
  registry.resolve = async () => {
    const captured = { ...server }
    if (validating) {
      await wait
    }
    return captured
  }
  response = async (method) => {
    validating = true
    return complete(method)
  }
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(0)
  server = { ...server, pairingRevision: 2 }
  notify!()
  await vi.advanceTimersByTimeAsync(0)
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it('rejects a completed catalog when its final snapshot proof straddles an external removal', async () => {
  await owner.discover()
  await vi.advanceTimersByTimeAsync(30_001)
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  registry.resolve = vi
    .fn()
    .mockResolvedValueOnce({ ...server })
    .mockResolvedValueOnce({ ...server })
    .mockImplementation(async () => {
      const captured = { ...server }
      await wait
      return captured
    })
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(0)
  list = []
  notify!()
  await vi.advanceTimersByTimeAsync(0)
  finish()
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it.each(['preparation', 'dispatch'] as const)(
  'invalidates socket proof when an external registry change straddles %s',
  async (phase) => {
    await vi.advanceTimersByTimeAsync(0)
    const connection: PairedRuntimeConnection = {
      endpoint: 'ws://server',
      hostPublicKeyB64: Buffer.from('server-key').toString('base64'),
      credential: { kind: 'token', deviceToken: 'home-token' }
    }
    server = { ...server, ...pairedOrchestrationPeers(connection.hostPublicKeyB64, 'home-token') }
    let finish!: () => void
    const wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    let preparing = false
    let allowed: boolean | void = undefined
    registry.resolve = async () => {
      const captured = { ...server }
      if (preparing && phase === 'preparation') {
        await wait
      }
      return captured
    }
    registry.call = async (_id, _method, _params, _timeout, _envelope, _revision, options) => {
      preparing = true
      const guard = await options!.prepareGuard!(connection)
      await wait
      allowed = guard()
      throw new Error('Invalidated socket proof')
    }
    const discovery = owner.discover('server')
    await vi.advanceTimersByTimeAsync(0)
    server = { ...server, pairingRevision: 2 }
    notify!()
    await vi.advanceTimersByTimeAsync(0)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(allowed).toBe(false)
    expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
    expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
  }
)

it('retains a safe late reply after the watcher fires and the full pairing is re-established', async () => {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  response = async (method) => {
    await wait
    return complete(method)
  }
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
  notify!()
  await vi.advanceTimersByTimeAsync(0)
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect((await owner.discover())[0]).toMatchObject({ status: 'fresh', observedAt: 1795204805000 })
})

it.each([
  { terminal: 'disposal', phase: 'before preparation' },
  { terminal: 'hard expiry', phase: 'before preparation' },
  { terminal: 'disposal', phase: 'during preparation' },
  { terminal: 'hard expiry', phase: 'during preparation' },
  { terminal: 'disposal', phase: 'at commit' },
  { terminal: 'hard expiry', phase: 'at commit' }
] as const)(
  'terminates catalog socket preparation on $terminal $phase',
  async ({ terminal, phase }) => {
    const { guard, discovery } = await pendingCatalogGuard()
    const terminate = (): void => {
      if (terminal === 'disposal') {
        owner.dispose()
      } else {
        // Model a wall-clock jump ahead of the transport's performance-based deadline.
        vi.setSystemTime(Date.now() + 15_001)
      }
    }
    let finish!: (value: OrchestrationWorkerServer) => void
    let entered!: () => void
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    if (phase === 'during preparation') {
      registry.resolve = () =>
        new Promise((resolve) => {
          finish = resolve
          entered()
        })
    }
    if (phase === 'before preparation') {
      terminate()
    }
    let consumed = false
    const request = expect(
      prepareCatalogRequest(
        async (connection) => {
          const commit = await guard(connection)
          if (phase === 'at commit') {
            terminate()
          }
          return () => {
            const allowed = commit()
            // Fail immediately if terminal authority loss is accidentally made retryable again.
            expect(allowed).not.toBe(false)
            return allowed
          }
        },
        () => {
          consumed = true
        }
      )
    ).rejects.toMatchObject({
      code: terminal === 'disposal' ? 'runtime_environment_changed' : 'runtime_timeout',
      data: { effectsApplied: false }
    })
    if (phase === 'during preparation') {
      await preparing
      terminate()
      finish({ ...server })
    }
    await request
    expect(consumed).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    await discovery
    expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
  }
)

it.each(['registry', 'generation'] as const)(
  'safely retries a catalog socket guard after recoverable %s proof invalidation',
  async (proof) => {
    const { guard, discovery } = await pendingCatalogGuard()
    let generation = 0
    vi.spyOn(environmentStore, 'environmentStoreWriteCount').mockImplementation(() => generation)
    let invalidate: (() => void) | undefined = () => {
      if (proof === 'registry') {
        notify!()
      } else {
        generation++
      }
    }
    let preparedRequest: { evidence: string }
    let consumed: { evidence: string } | undefined
    await prepareCatalogRequest(
      async (connection) => {
        const commit = await guard(connection)
        preparedRequest = { evidence: invalidate ? 'before invalidation' : 'after invalidation' }
        invalidate?.()
        invalidate = undefined
        return commit
      },
      () => {
        consumed = preparedRequest
      }
    )
    expect(consumed).toEqual({ evidence: 'after invalidation' })
    await vi.advanceTimersByTimeAsync(15_000)
    await discovery
  }
)

it('preserves pairing mismatch refusal through catalog socket preparation', async () => {
  const { guard, discovery } = await pendingCatalogGuard()
  server = { ...server, pairingRevision: 2 }
  let consumed = false
  await expect(
    prepareCatalogRequest(guard, () => {
      consumed = true
    })
  ).rejects.toMatchObject({ code: 'server_pairing_changed' })
  expect(consumed).toBe(false)
  await vi.advanceTimersByTimeAsync(15_000)
  await discovery
})

it('spends only the remaining discovery budget after a slow registry enumeration', async () => {
  let finish!: (value: typeof list) => void
  registry.list = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  registry.resolve = () => new Promise(() => {})
  const discovery = owner.discover()
  await vi.advanceTimersByTimeAsync(4_000)
  finish(list)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
})

it('discards an initial pairing resolution completed after discovery expired', async () => {
  let finish!: (value: OrchestrationWorkerServer) => void
  registry.resolve = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const discovery = owner.discover('server')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await discovery).toMatchObject([{ status: 'unchecked', reason: 'no_answer' }])
  finish(server)
  await vi.advanceTimersByTimeAsync(0)
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
})

it('rejects late retention after the owning database is disposed', async () => {
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  response = async (method) => {
    await wait
    return complete(method)
  }
  const discovery = owner.discover()
  await vi.advanceTimersByTimeAsync(5_000)
  await discovery
  db.close()
  db = new OrchestrationDb(path)
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
  expect(await owner.discover()).toEqual([])
})

it.each(['lists', 'validation'] as const)(
  'rejects retention when %s complete past the hard deadline',
  async (phase) => {
    let finish!: () => void
    const wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    if (phase === 'lists') {
      response = async (method) => {
        await wait
        return complete(method)
      }
    } else {
      let validating = false
      registry.resolve = async () => {
        if (validating) {
          await wait
        }
        return { ...server }
      }
      response = async (method) => {
        validating = true
        return complete(method)
      }
    }
    const discovery = owner.discover('server')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await discovery).toMatchObject([{ status: 'unchecked' }])
    await vi.advanceTimersByTimeAsync(10_000)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.db.prepare('SELECT environment_id FROM worker_placement_catalogs').all()).toEqual([])
  }
)

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

it('persists a downgrade across a clock rollback and restart', async () => {
  await owner.discover()
  vi.setSystemTime(new Date('2026-11-20T19:00:00Z'))
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
  response = async () => {
    throw new Error('offline')
  }
  const snapshot = (await owner.discover())[0]
  expect(snapshot).toMatchObject({ status: 'fresh', observedAt: 1795201200000 })
  if (snapshot.status === 'fresh') {
    expect(classifyWorkerPlacementCatalog(snapshot.catalog)[0]).toMatchObject({
      classification: 'registered_not_usable',
      explicitStart: { usable: false, reason: 'unsupported_target' }
    })
  }
})

it('upgrades a v50 database with only this slice’s additive catalog table', async () => {
  db.db.exec('DROP TABLE worker_placement_catalogs')
  db.db.pragma('user_version = 50')
  db.close()
  db = new OrchestrationDb(path)
  owner = new WorkerPlacementCatalogOwner(db, transport())
  expect((await owner.discover())[0]).toMatchObject({ status: 'fresh' })
})
