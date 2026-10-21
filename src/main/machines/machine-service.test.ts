import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineProviderError } from '../../shared/machine-provider-protocol'
import { getMachineInventoryStorePath } from './machine-inventory-store'
import { MachineService } from './machine-service'
import {
  KEY,
  LOCAL_NOW,
  capabilities,
  envelope,
  fail,
  inventory,
  machine,
  removeMachineServiceRoots,
  reply,
  setup
} from './machine-service.test-fixture'

afterEach(removeMachineServiceRoots)

describe('MachineService list', () => {
  it('records machines, the provider clock offset, and sends contextId once known', async () => {
    const { service, calls } = await setup({ list: inventory([machine()]) })
    const snapshot = await service.list(KEY)
    expect(snapshot).toMatchObject({
      contextId: 'omarchy:neil',
      clockOffsetMs: 5_000,
      machines: [{ id: 'sbx-1', state: 'running', providerKey: KEY, lastSeenAt: LOCAL_NOW }]
    })
    expect(calls.map((call) => [call.verb, call.contextId])).toEqual([
      ['capabilities', undefined],
      ['list', 'omarchy:neil']
    ])
  })

  it('coalesces concurrent lists into one provider call', async () => {
    const { service, verbs } = await setup({ list: inventory([machine()]) })
    await Promise.all([service.list(KEY), service.list(KEY), service.list(KEY)])
    expect(verbs().filter((verb) => verb === 'list')).toHaveLength(1)
  })

  it('marks rows unreachable on failure, backs off, and lets a forced refresh through', async () => {
    const { service, verbs } = await setup({
      list: [inventory([machine()]), fail('unavailable'), inventory([machine()])]
    })
    await service.list(KEY)
    const failed = await service.list(KEY, { force: true })
    expect(failed.machines[0]).toMatchObject({ state: 'unreachable', lastSeenAt: LOCAL_NOW })
    expect(failed.lastFailure?.code).toBe('unavailable')

    await service.list(KEY)
    expect(verbs().filter((verb) => verb === 'list')).toHaveLength(2)
    expect((await service.list(KEY, { force: true })).machines[0]?.state).toBe('running')
  })

  it('keeps bound machines missing from a list as gone and drops unbound ones', async () => {
    const { service } = await setup({
      list: [inventory([machine(), machine({ id: 'sbx-2' })]), inventory([])]
    })
    await service.list(KEY)
    await service.connect(KEY, 'sbx-1').catch(() => undefined)
    const snapshot = await service.list(KEY, { force: true })
    expect(snapshot.machines).toEqual([
      expect.objectContaining({ id: 'sbx-1', state: 'gone', sshTargetId: expect.any(String) })
    ])
  })

  it('applies nothing when the provider is now signed in as a different account', async () => {
    const { service, deps } = await setup({
      capabilities: [
        capabilities,
        async (args) => ({
          ...envelope(args),
          contextId: 'omarchy:other',
          kind: 'capabilities',
          capabilities: { verbs: ['get'], lifetimes: ['persistent'], contextId: 'omarchy:other' }
        })
      ],
      list: inventory([machine()])
    })
    await service.list(KEY)
    const restarted = new MachineService(deps)
    const snapshot = await restarted.list(KEY, { force: true })
    expect(snapshot.lastFailure?.code).toBe('context-mismatch')
    expect(snapshot.contextId).toBe('omarchy:neil')
  })
})

describe('MachineService mutations', () => {
  it('joins a duplicate request and refuses a different concurrent action', async () => {
    const { service, verbs } = await setup({
      list: inventory([machine({ state: 'sleeping', access: undefined })]),
      wake: reply(machine())
    })
    await service.list(KEY)
    const first = service.wake(KEY, 'sbx-1')
    const second = service.wake(KEY, 'sbx-1')
    await expect(service.sleep(KEY, 'sbx-1')).rejects.toMatchObject({ code: 'conflict' })
    await Promise.all([first, second])
    expect(verbs().filter((verb) => verb === 'wake')).toHaveLength(1)
  })

  it('never re-runs a timed-out mutation; it reconciles with one read', async () => {
    const { service, verbs } = await setup({
      list: inventory([machine()]),
      sleep: fail('timeout'),
      get: reply(machine({ state: 'sleeping', access: undefined }))
    })
    await service.list(KEY)
    const record = await service.sleep(KEY, 'sbx-1')
    expect(record.state).toBe('sleeping')
    expect(verbs().slice(2)).toEqual(['sleep', 'get'])
  })

  it('treats an unconfirmed transition as unknown and reconciles', async () => {
    const { service, verbs } = await setup({
      list: inventory([machine()]),
      sleep: reply(machine()),
      get: reply(machine())
    })
    await service.list(KEY)
    expect((await service.sleep(KEY, 'sbx-1')).state).toBe('running')
    expect(verbs().slice(2)).toEqual(['sleep', 'get'])
  })

  it('polls a waking machine until it runs', async () => {
    const { service, delay } = await setup({
      list: inventory([machine({ state: 'sleeping', access: undefined })]),
      wake: reply(machine({ state: 'waking', access: undefined })),
      get: [reply(machine({ state: 'waking', access: undefined })), reply(machine())]
    })
    await service.list(KEY)
    expect((await service.wake(KEY, 'sbx-1')).state).toBe('running')
    expect(delay).toHaveBeenCalledWith(3_000)
  })

  it('treats delete → not-found as done and removes the SSH target', async () => {
    const { service, removeSshTarget } = await setup({
      list: inventory([machine()]),
      delete: fail('not-found')
    })
    await service.list(KEY)
    expect((await service.delete(KEY, 'sbx-1')).state).toBe('gone')
    expect(removeSshTarget).toHaveBeenCalledTimes(1)
  })
})

describe('MachineService create', () => {
  it('persists the pending operation before the provider runs and clears it after', async () => {
    const pendingSeen: unknown[] = []
    const { service, userDataPath } = await setup({
      create: async (args) => {
        const stored = JSON.parse(
          await readFile(getMachineInventoryStorePath(userDataPath), 'utf8')
        )
        pendingSeen.push(...stored.providers[KEY].pendingCreates)
        return reply(machine({ creatingOperationId: args.operationId }))(args)
      }
    })
    const record = await service.create(
      KEY,
      { name: 'dev', lifetime: 'temporary', ttlSeconds: 600 },
      { operationId: 'op-create' }
    )
    expect(pendingSeen).toEqual([expect.objectContaining({ operationId: 'op-create' })])
    expect(record.creatingOperationId).toBe('op-create')
    expect(service.snapshots()[0]?.pendingCreates).toEqual([])
  })

  it('reconciles an unknown create outcome by its operationId instead of creating again', async () => {
    const { service, verbs } = await setup({
      create: fail('timeout'),
      list: inventory([machine({ creatingOperationId: 'op-create' })])
    })
    const record = await service.create(
      KEY,
      { name: 'dev', lifetime: 'persistent' },
      { operationId: 'op-create' }
    )
    expect(record.id).toBe('sbx-1')
    expect(verbs().filter((verb) => verb === 'create')).toHaveLength(1)
    expect(service.snapshots()[0]?.pendingCreates).toEqual([])
  })

  it('keeps a cancelled create pending and checks for a leftover at 0s, 10s and 60s', async () => {
    let releaseCreate: () => void = () => undefined
    const { service, delay, verbs } = await setup({
      create: (args) =>
        new Promise((_resolve, reject) => {
          releaseCreate = () => reject(new MachineProviderError('cancelled', 'cancelled'))
          void args
        }),
      list: inventory([])
    })
    const pending = service.create(
      KEY,
      { name: 'dev', lifetime: 'persistent' },
      { operationId: 'op-cancel' }
    )
    await vi.waitFor(() => expect(verbs()).toContain('create'))
    expect(service.cancelCreate('op-cancel')).toBe(true)
    releaseCreate()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(verbs().filter((verb) => verb === 'list')).toHaveLength(3))
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([0, 10_000, 50_000])
    expect(service.snapshots()[0]?.pendingCreates).toEqual([
      expect.objectContaining({ operationId: 'op-cancel' })
    ])
  })

  it('drops the pending row when the provider definitively refuses', async () => {
    const { service } = await setup({ create: fail('quota') })
    await expect(
      service.create(KEY, { name: 'dev', lifetime: 'persistent' })
    ).rejects.toMatchObject({ code: 'quota' })
    expect(service.snapshots()[0]?.pendingCreates).toEqual([])
  })

  it('refuses a lifetime above the provider maximum without running create', async () => {
    const { service, verbs } = await setup({})
    await expect(
      service.create(KEY, { name: 'dev', lifetime: 'temporary', ttlSeconds: 7200 })
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(verbs()).toEqual(['capabilities'])
  })
})

describe('MachineService connect', () => {
  it('leaves a failed machine unreachable and never removes its target', async () => {
    const { service, removeSshTarget, sshTargets } = await setup({ list: inventory([machine()]) })
    await service.list(KEY)
    await expect(service.connect(KEY, 'sbx-1')).rejects.toThrow('Connection refused')
    expect(sshTargets.ensureTarget).toHaveBeenCalledTimes(1)
    expect(removeSshTarget).not.toHaveBeenCalled()
    expect(service.snapshots()[0]?.machines[0]).toMatchObject({
      state: 'unreachable',
      lastError: 'Connection refused'
    })
  })
})
