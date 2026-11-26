import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { WorkerPlacementCatalogOwner } from './worker-placement-catalog-owner'
import * as resolution from '../../../../workspaces/execution-host/local-project-runtime-resolution'
import { projectSetupsWithWorkerExecutionTargets } from './worker-execution-target'
import {
  catalogRuntimeStore,
  storeProject,
  storeRepo
} from '../../../construction/test-context/runtime-catalog-store.test-fixture'
import type { ProjectHostSetup } from '../../../../../shared/project/project-types'
import {
  pairedOrchestrationPeers,
  type OrchestrationEnvironmentTransport
} from '../environment-transport'
import type { PairedRuntimeConnection } from '../../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { RuntimeRequestGuard } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { prepareCurrentRuntimeRequest } from '../../../../../shared/remote-runtime/requests/remote-runtime-request-preparation'
import * as environmentStore from '../../../../../shared/remote-runtime/host-store/runtime-environment-store-worker-client'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// PR #45948 F4: terminal catalog authority must stop socket preparation instead of busy-retrying.
it.each(['disposed', 'hard-deadline', 'stale-proof'] as const)(
  'bounds actual transport preparation and pairing reads for %s catalog authority',
  async (phase) => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const connection: PairedRuntimeConnection = {
      endpoint: 'ws://server',
      hostPublicKeyB64: Buffer.from('server-key').toString('base64'),
      credential: { kind: 'token', deviceToken: 'home-token' }
    }
    const resolve = vi.fn<OrchestrationEnvironmentTransport['resolve']>(async () => ({
      environmentId: 'server',
      name: 'server',
      pairingRevision: 1,
      ...pairedOrchestrationPeers(connection.hostPublicKeyB64, 'home-token')
    }))
    let capture!: (guard: RuntimeRequestGuard) => void
    const captured = new Promise<RuntimeRequestGuard>((resolve) => {
      capture = resolve
    })
    const owner = new WorkerPlacementCatalogOwner(db, {
      list: async () => [{ environmentId: 'server', name: 'server' }],
      resolve,
      call: async (_id, _method, _params, _timeout, _envelope, _revision, options) => {
        capture(options!.prepareGuard!)
        return await new Promise(() => {})
      }
    })
    try {
      const discovery = owner.discover()
      const prepare = await captured
      resolve.mockClear()
      let generation = 0
      vi.spyOn(environmentStore, 'environmentStoreWriteCount').mockImplementation(() => generation)
      if (phase === 'disposed') {
        owner.dispose()
      } else if (phase === 'hard-deadline') {
        vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 15_001)
      }
      const guard = vi.fn<RuntimeRequestGuard>(async (selected) => {
        const commit = await prepare(selected)
        if (phase === 'stale-proof') {
          generation = 1
        }
        return commit
      })
      let consumed = false
      const request = prepareCurrentRuntimeRequest({
        connection,
        guard,
        current: () => guard.mock.calls.length < 25,
        deadline: Infinity,
        expire: () => {},
        consume: () => {
          consumed = true
        }
      })
      if (phase === 'stale-proof') {
        await request
        expect(consumed).toBe(true)
        expect(guard).toHaveBeenCalledTimes(2)
        expect(resolve).toHaveBeenCalledTimes(2)
      } else {
        await expect(request).rejects.toMatchObject({
          code: phase === 'disposed' ? 'runtime_environment_changed' : 'runtime_timeout',
          data: { effectsApplied: false }
        })
        expect(consumed).toBe(false)
        expect(guard).toHaveBeenCalledTimes(1)
        expect(resolve).toHaveBeenCalledTimes(0)
      }
      await vi.advanceTimersByTimeAsync(15_000)
      await discovery
    } finally {
      db.close()
    }
  }
)

// PR #45948: overlapping discovery of unresponsive peers must share the outstanding catalog RPCs.
it('shares one list pair per server across concurrent discoveries and keeps timed-out work in its slot', async () => {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const call = vi.fn<OrchestrationEnvironmentTransport['call']>(() => new Promise(() => {}))
  const owner = new WorkerPlacementCatalogOwner(db, {
    list: async () => [{ environmentId: 'server', name: 'server' }],
    resolve: async () => ({
      environmentId: 'server',
      name: 'server',
      peerFingerprint: 'peer',
      homePeerFingerprint: 'home',
      pairingRevision: 1
    }),
    call
  })
  try {
    const discoveries = [owner.discover(), owner.discover(), owner.discover()]
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await Promise.all(discoveries)).map((answer) => answer[0].status)).toEqual([
      'unchecked',
      'unchecked',
      'unchecked'
    ])
    expect(call).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await owner.discover())[0].status).toBe('unchecked')
    expect(call).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})

// PR #45948 F2: stalled registry or pairing reads used to multiply across discovery deadlines.
it.each(['registry', 'initial pairing', 'validation', 'snapshot validation'] as const)(
  'bounds stalled %s work across concurrent and repeated discovery deadlines',
  async (phase) => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    let validating = false
    let validatedRead = false
    let finishRegistry!: (servers: readonly { environmentId: string; name: string }[]) => void
    const list = vi.fn<NonNullable<OrchestrationEnvironmentTransport['list']>>(() =>
      phase === 'registry'
        ? new Promise((resolve) => {
            finishRegistry = resolve
          })
        : Promise.resolve([{ environmentId: 'server', name: 'server' }])
    )
    const resolve = vi.fn<OrchestrationEnvironmentTransport['resolve']>(() => {
      if (
        phase === 'initial pairing' ||
        (validating && (phase !== 'snapshot validation' || validatedRead))
      ) {
        return new Promise(() => {})
      }
      validatedRead ||= validating
      return Promise.resolve({
        environmentId: 'server',
        name: 'server',
        peerFingerprint: 'peer',
        homePeerFingerprint: 'home',
        pairingRevision: 1
      })
    })
    const call = vi.fn<OrchestrationEnvironmentTransport['call']>(async (_id, method) => {
      validating = true
      return {
        id: 'read',
        ok: true,
        _meta: { runtimeId: 'peer' },
        result: method === 'repo.list' ? { repos: [] } : { setups: [] }
      }
    })
    const owner = new WorkerPlacementCatalogOwner(db, { list, resolve, call })
    try {
      for (let wave = 0; wave < 4; wave++) {
        const pending = Promise.allSettled([owner.discover(), owner.discover(), owner.discover()])
        await vi.advanceTimersByTimeAsync(5_000)
        expect(await pending).toEqual(
          phase === 'registry'
            ? [
                {
                  status: 'rejected',
                  reason: expect.objectContaining({ code: 'runtime_timeout' })
                },
                {
                  status: 'rejected',
                  reason: expect.objectContaining({ code: 'runtime_timeout' })
                },
                { status: 'rejected', reason: expect.objectContaining({ code: 'runtime_timeout' }) }
              ]
            : [
                { status: 'fulfilled', value: [expect.objectContaining({ status: 'unchecked' })] },
                { status: 'fulfilled', value: [expect.objectContaining({ status: 'unchecked' })] },
                { status: 'fulfilled', value: [expect.objectContaining({ status: 'unchecked' })] }
              ]
        )
      }
      expect(list).toHaveBeenCalledTimes(phase === 'registry' ? 1 : 4)
      expect(resolve).toHaveBeenCalledTimes(
        phase === 'registry' ? 0 : phase === 'initial pairing' ? 1 : phase === 'validation' ? 2 : 3
      )
      expect(call).toHaveBeenCalledTimes(
        phase === 'validation' || phase === 'snapshot validation' ? 2 : 0
      )
      if (phase === 'registry') {
        finishRegistry([{ environmentId: 'server', name: 'server' }])
        await vi.advanceTimersByTimeAsync(0)
        expect(resolve).toHaveBeenCalledTimes(0)
        expect(call).toHaveBeenCalledTimes(0)
      }
    } finally {
      db.close()
    }
  }
)

// PR #45948 F2: each unknown ID used to allocate its own stalled pairing read.
it('does not allocate pairing reads for concurrent queries naming unregistered environments', async () => {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const list = vi.fn<NonNullable<OrchestrationEnvironmentTransport['list']>>(async () => [])
  const resolve = vi.fn<OrchestrationEnvironmentTransport['resolve']>(() => new Promise(() => {}))
  const call = vi.fn<OrchestrationEnvironmentTransport['call']>(() => new Promise(() => {}))
  const owner = new WorkerPlacementCatalogOwner(db, { list, resolve, call })
  try {
    const pending = Array.from({ length: 100 }, (_, index) => owner.discover(`missing-${index}`))
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await Promise.all(pending)).every((answer) => answer[0].status === 'unchecked')).toBe(
      true
    )
    expect(list).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(0)
    expect(call).toHaveBeenCalledTimes(0)
  } finally {
    db.close()
  }
})

// PR #45948 F5: a notification burst during a failed enumeration owes one follow-up, even if that fails too.
it('coalesces notifications during failed registry reconciliation', async () => {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const first = Promise.withResolvers<[]>()
  const list = vi
    .fn<NonNullable<OrchestrationEnvironmentTransport['list']>>()
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(new Error('Registry unavailable'))
    .mockImplementation(() => new Promise(() => {}))
  let notify!: () => void
  new WorkerPlacementCatalogOwner(db, {
    list,
    resolve: vi.fn(),
    call: vi.fn(),
    onCatalogChanged: (listener) => {
      notify = listener
      return () => {}
    }
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 100; i++) {
      notify()
    }
    first.reject(new Error('Registry read failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})

// PR #45948 F3: watcher invalidation must fence stale proof without replacing stalled operation slots.
it.each(['registry', 'pairing', 'catalog'] as const)(
  'keeps stalled %s work bounded across external registry notifications',
  async (phase) => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    let notify!: () => void
    let pairingRevision = 1
    const list = vi.fn<NonNullable<OrchestrationEnvironmentTransport['list']>>(() =>
      phase === 'registry'
        ? new Promise(() => {})
        : Promise.resolve([{ environmentId: 'server', name: 'server' }])
    )
    const resolve = vi.fn<OrchestrationEnvironmentTransport['resolve']>(() =>
      phase === 'pairing'
        ? new Promise(() => {})
        : Promise.resolve({
            environmentId: 'server',
            name: 'server',
            peerFingerprint: 'peer',
            homePeerFingerprint: 'home',
            pairingRevision
          })
    )
    const call = vi.fn<OrchestrationEnvironmentTransport['call']>(() => new Promise(() => {}))
    const owner = new WorkerPlacementCatalogOwner(db, {
      list,
      resolve,
      call,
      onCatalogChanged: (listener) => {
        notify = listener
        return () => {}
      }
    })
    try {
      for (let wave = 0; wave < 4; wave++) {
        const pending = Promise.allSettled([owner.discover(), owner.discover(), owner.discover()])
        await vi.advanceTimersByTimeAsync(0)
        pairingRevision++
        notify()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(await pending).toEqual(
          Array(3).fill(
            phase === 'registry'
              ? { status: 'rejected', reason: expect.objectContaining({ code: 'runtime_timeout' }) }
              : { status: 'fulfilled', value: [expect.objectContaining({ status: 'unchecked' })] }
          )
        )
      }
      if (phase === 'registry') {
        expect(list).toHaveBeenCalledTimes(1)
      }
      if (phase !== 'catalog') {
        expect(resolve).toHaveBeenCalledTimes(phase === 'registry' ? 0 : 1)
      }
      expect(call).toHaveBeenCalledTimes(phase === 'catalog' ? 2 : 0)
    } finally {
      db.close()
    }
  }
)

// PR #45948: per-setup launch resolution repeated the same work for every checkout of a shared project.
it('indexes a full-size shared project once and resolves a shared worktree scope once', () => {
  const resolve = vi.spyOn(resolution, 'resolveLocalWorkspaceRuntime')
  const repos = Array.from({ length: 5_000 }, (_, index) =>
    storeRepo({ id: `repo-${index}`, path: `/repo/${index}` })
  )
  const getProjects = vi.fn(() => [
    storeProject({ id: 'project', sourceRepoIds: repos.map((repo) => repo.id) })
  ])
  const getSettings = vi.fn(() => ({
    workspaceDir: '\\\\wsl.localhost\\Ubuntu\\worktrees',
    nestWorkspaces: false
  }))
  const store = catalogRuntimeStore({ getProjects, getSettings })
  const setups: ProjectHostSetup[] = repos.map((repo) => ({
    id: `setup-${repo.id}`,
    projectId: 'project',
    repoId: repo.id,
    hostId: 'local',
    path: repo.path,
    displayName: repo.id,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }))
  expect(projectSetupsWithWorkerExecutionTargets(store, repos, setups)).toHaveLength(5_000)
  expect(getProjects).toHaveBeenCalledTimes(1)
  expect(getSettings).toHaveBeenCalledTimes(1)
  expect(resolve).toHaveBeenCalledTimes(1)
})
