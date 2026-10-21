import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { MachineService } from './machine-service'
import {
  KEY,
  fail,
  inventory,
  machine,
  removeMachineServiceRoots,
  reply,
  setup,
  type Handler
} from './machine-service.test-fixture'

afterEach(removeMachineServiceRoots)

const SLEEPING = machine({ state: 'sleeping', access: undefined })

/** A provider answer the test releases, so a read can be made to finish after a mutation. */
function held(answer: Handler): { handler: Handler; release: () => void } {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    handler: async (args) => {
      await gate
      return answer(args)
    },
    release
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('MachineService reads against lifecycle results', () => {
  it('keeps a sleep result over a list that began before the sleep finished', async () => {
    const staleList = held(inventory([machine()]))
    const { service } = await setup({
      list: [inventory([machine()]), staleList.handler],
      sleep: reply(SLEEPING)
    })
    await service.list(KEY)
    const listing = service.list(KEY, { force: true })
    await tick()
    await expect(service.sleep(KEY, 'sbx-1')).resolves.toMatchObject({ state: 'sleeping' })
    staleList.release()
    await listing
    expect(service.snapshots()[0]?.machines[0]?.state).toBe('sleeping')
  })

  it('keeps a machine a create made over a list that began before it existed', async () => {
    const staleList = held(inventory([]))
    const { service } = await setup({
      list: [inventory([]), staleList.handler],
      create: (args) => reply(machine({ creatingOperationId: args.operationId }))(args)
    })
    await service.list(KEY)
    const listing = service.list(KEY, { force: true })
    await tick()
    await service.create(KEY, { name: 'dev', lifetime: 'persistent' })
    staleList.release()
    await listing
    expect(service.snapshots()[0]?.machines).toEqual([
      expect.objectContaining({ id: 'sbx-1', state: 'running' })
    ])
  })

  it('keeps a wake result over a get that began before the wake finished', async () => {
    const staleGet = held(reply(SLEEPING))
    const { service } = await setup({
      list: inventory([SLEEPING]),
      get: staleGet.handler,
      wake: reply(machine())
    })
    await service.list(KEY)
    const reading = service.get(KEY, 'sbx-1')
    await tick()
    await service.wake(KEY, 'sbx-1')
    staleGet.release()
    await expect(reading).resolves.toMatchObject({ state: 'running' })
  })
})

describe('MachineService fences failures and settled polls', () => {
  it('keeps a wake that settled by polling over a list that began mid-poll', async () => {
    const settlingGet = held(reply(machine()))
    const staleList = held(inventory([machine({ state: 'waking', access: undefined })]))
    const { service, verbs } = await setup({
      list: [inventory([SLEEPING]), staleList.handler],
      wake: reply(machine({ state: 'waking', access: undefined })),
      get: settlingGet.handler
    })
    await service.list(KEY)
    const waking = service.wake(KEY, 'sbx-1')
    while (!verbs().includes('get')) {
      await tick()
    }
    const listing = service.list(KEY, { force: true })
    await tick()
    settlingGet.release()
    await expect(waking).resolves.toMatchObject({ state: 'running' })
    staleList.release()
    await listing
    expect(service.snapshots()[0]?.machines[0]?.state).toBe('running')
  })

  it('does not mark unreachable from a get that failed after a newer sleep settled', async () => {
    const failingGet = held(fail('unavailable'))
    const { service } = await setup({
      list: inventory([machine()]),
      get: failingGet.handler,
      sleep: reply(SLEEPING)
    })
    await service.list(KEY)
    const reading = service.get(KEY, 'sbx-1').catch(() => undefined)
    await tick()
    await service.sleep(KEY, 'sbx-1')
    failingGet.release()
    await reading
    expect(service.snapshots()[0]?.machines[0]?.state).toBe('sleeping')
  })

  it('does not mark unreachable from a connect that failed after a newer sleep settled', async () => {
    const { service, sshTargets } = await setup({
      list: inventory([machine()]),
      sleep: reply(SLEEPING),
      get: reply(SLEEPING)
    })
    let failConnect: () => void = () => undefined
    vi.mocked(sshTargets.connect).mockImplementationOnce(
      (id) =>
        new Promise((resolve) => {
          failConnect = () =>
            resolve({ targetId: id, status: 'error', error: 'refused', reconnectAttempt: 0 })
        })
    )
    await service.list(KEY)
    const connecting = service.connect(KEY, 'sbx-1').catch(() => undefined)
    await tick()
    await service.sleep(KEY, 'sbx-1')
    failConnect()
    await connecting
    expect(service.snapshots()[0]?.machines[0]?.state).toBe('sleeping')
  })
})

describe('MachineService never flashes unreachable on an answered provider', () => {
  it('keeps a woken machine running when a list that began before the wake then fails', async () => {
    const failingList = held(fail('unavailable'))
    const { service } = await setup({
      list: [inventory([SLEEPING]), failingList.handler],
      wake: reply(machine())
    })
    await service.list(KEY)
    const listing = service.list(KEY, { force: true })
    await tick()
    await service.wake(KEY, 'sbx-1')
    failingList.release()
    await listing
    expect(service.snapshots()[0]?.machines[0]?.state).toBe('running')
  })

  it('reads an unconfirming answer without first marking the machine unreachable', async () => {
    const states: string[] = []
    const { deps } = await setup({
      list: inventory([machine()]),
      delete: reply(machine({ state: 'unknown', access: undefined })),
      get: fail('not-found')
    })
    const service = new MachineService({
      ...deps,
      onChanged: (snapshot) => states.push(snapshot.machines[0]?.state ?? 'none')
    })
    await service.list(KEY)
    await expect(service.delete(KEY, 'sbx-1')).resolves.toMatchObject({ state: 'gone' })
    expect(states).not.toContain('unreachable')
  })
})

describe('MachineService pairing credentials', () => {
  const code = (deviceToken: string) =>
    encodePairingOffer({
      v: 2,
      endpoint: 'wss://sandbox.example.com',
      deviceToken,
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })

  it('pairs again after a failed pairing instead of trusting the offered code', async () => {
    const orcaServer = machine({
      access: { kind: 'orca-server', pairingCode: code('first'), projectRoot: '/w' }
    })
    const { deps } = await setup({ list: inventory([orcaServer]), get: reply(orcaServer) })
    const add = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: 'unreachable', message: 'no answer' })
      .mockResolvedValueOnce({ ok: true, environment: { id: 'env-1' } })
    const service = new MachineService({ ...deps, pairing: { add, repair: vi.fn() } })
    await service.list(KEY)
    await expect(service.connect(KEY, 'sbx-1')).rejects.toThrow('no answer')
    expect(service.snapshots()[0]?.machines[0]?.pairingCodeSha256).toBeUndefined()
    await expect(service.connect(KEY, 'sbx-1')).resolves.toMatchObject({
      runtimeEnvironmentId: 'env-1'
    })
    expect(add).toHaveBeenCalledTimes(2)
    expect(service.snapshots()[0]?.machines[0]?.pairingCodeSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('repairs with a rotated code after pairing once', async () => {
    const first = machine({
      access: { kind: 'orca-server', pairingCode: code('first'), projectRoot: '/w' }
    })
    const rotated = machine({
      access: { kind: 'orca-server', pairingCode: code('rotated'), projectRoot: '/w' }
    })
    const { deps } = await setup({
      list: [inventory([first]), inventory([rotated])],
      get: [reply(first), reply(rotated)]
    })
    const repair = vi.fn(async () => ({ ok: true as const, environment: { id: 'env-1' } }))
    const service = new MachineService({
      ...deps,
      pairing: {
        add: vi.fn(async () => ({ ok: true as const, environment: { id: 'env-1' } })),
        repair
      }
    })
    await service.list(KEY)
    await service.connect(KEY, 'sbx-1')
    // A list that offers the rotated code must not make the next connect skip the repair.
    await service.list(KEY, { force: true })
    await service.connect(KEY, 'sbx-1')
    expect(repair).toHaveBeenCalledTimes(1)
  })
})
