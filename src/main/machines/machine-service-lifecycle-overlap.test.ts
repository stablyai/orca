import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { MachineService } from './machine-service'
import {
  KEY,
  capabilities,
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
const PAIRING_CODE = encodePairingOffer({
  v: 2,
  endpoint: 'wss://sandbox.example.com',
  deviceToken: 'device-token',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64')
})

/** A handler that answers only once the test lets it, like a provider still stopping. */
function heldReply(answer: Handler): { handler: Handler; release: () => void } {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    handler: async (args) => {
      await held
      return answer(args)
    },
    release
  }
}

describe('MachineService lifecycle overlap', () => {
  it('runs a wake asked for during a sleep once the sleep finishes, instead of refusing it', async () => {
    const sleep = heldReply(reply(SLEEPING))
    const { service, verbs } = await setup({
      list: inventory([machine()]),
      sleep: sleep.handler,
      wake: reply(machine())
    })
    await service.list(KEY)
    const slept = service.sleep(KEY, 'sbx-1')
    const woken = service.wake(KEY, 'sbx-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(verbs()).not.toContain('wake')
    sleep.release()
    await expect(slept).resolves.toMatchObject({ state: 'sleeping' })
    await expect(woken).resolves.toMatchObject({ state: 'running' })
    expect(verbs().filter((verb) => verb === 'sleep' || verb === 'wake')).toEqual(['sleep', 'wake'])
  })

  it('still refuses a wake while a delete runs', async () => {
    const remove = heldReply(fail('not-found'))
    const { service } = await setup({ list: inventory([machine()]), delete: remove.handler })
    await service.list(KEY)
    const deleted = service.delete(KEY, 'sbx-1')
    await expect(service.wake(KEY, 'sbx-1')).rejects.toMatchObject({ code: 'conflict' })
    remove.release()
    await deleted
  })

  it('follows a sleep answered stopping until the machine sleeps', async () => {
    const { service, delay } = await setup({
      list: inventory([machine()]),
      sleep: reply(machine({ state: 'stopping', access: undefined })),
      get: [reply(machine({ state: 'stopping', access: undefined })), reply(SLEEPING)]
    })
    await service.list(KEY)
    await expect(service.sleep(KEY, 'sbx-1')).resolves.toMatchObject({ state: 'sleeping' })
    expect(delay).toHaveBeenCalledWith(3_000)
  })

  it("retires a deleted orca-server machine's paired server", async () => {
    const retired: string[] = []
    const orcaServer = machine({
      access: { kind: 'orca-server', pairingCode: PAIRING_CODE, projectRoot: '/w' }
    })
    const { deps } = await setup({
      list: [inventory([orcaServer]), inventory([]), inventory([])],
      get: reply(orcaServer),
      delete: fail('not-found')
    })
    const service = new MachineService({
      ...deps,
      isHostReferenced: () => true,
      pairing: {
        add: vi.fn(async () => ({ ok: true as const, environment: { id: 'env-paired' } })),
        repair: vi.fn()
      },
      retireEnvironment: (environmentId) => retired.push(environmentId)
    })
    await service.list(KEY)
    await expect(service.connect(KEY, 'sbx-1')).resolves.toMatchObject({ kind: 'orca-server' })
    await service.delete(KEY, 'sbx-1')
    await service.list(KEY, { force: true })
    await service.list(KEY, { force: true })
    expect(retired).toEqual(['env-paired'])
    expect(service.snapshots()[0]?.machines).toEqual([
      expect.objectContaining({ state: 'gone', runtimeEnvironmentId: 'env-paired' })
    ])
  })

  it('does not count a delete answered with a machine as done while the machine still exists', async () => {
    const { service, removeSshTarget } = await setup({
      list: inventory([machine()]),
      delete: reply(machine({ state: 'unknown', access: undefined })),
      get: reply(machine({ state: 'error', access: undefined }))
    })
    await service.list(KEY)
    expect((await service.delete(KEY, 'sbx-1')).state).toBe('error')
    expect(removeSshTarget).not.toHaveBeenCalled()
  })

  it('finishes a delete answered with a machine once a read finds nothing', async () => {
    const { service, removeSshTarget } = await setup({
      list: inventory([machine()]),
      delete: reply(machine({ state: 'error', access: undefined })),
      get: fail('not-found')
    })
    await service.list(KEY)
    expect((await service.delete(KEY, 'sbx-1')).state).toBe('gone')
    expect(removeSshTarget).toHaveBeenCalledTimes(1)
  })

  it('follows a timed-out create it adopts while the machine is still creating', async () => {
    const { service, delay } = await setup({
      create: fail('timeout'),
      list: [
        inventory([]),
        inventory([
          machine({ state: 'creating', access: undefined, creatingOperationId: 'op-adopt' })
        ])
      ],
      get: [reply(machine({ state: 'creating', access: undefined })), reply(machine())]
    })
    await service.list(KEY)
    const record = await service.create(
      KEY,
      { name: 'dev', lifetime: 'persistent' },
      { operationId: 'op-adopt' }
    )
    expect(record).toMatchObject({ state: 'running', access: { kind: 'ssh' } })
    expect(delay).toHaveBeenCalledWith(3_000)
  })

  it('stops a create canceled while capabilities load, before asking the provider', async () => {
    const loading = heldReply(capabilities)
    const { service, verbs } = await setup({
      capabilities: loading.handler,
      create: reply(machine())
    })
    const created = service.create(
      KEY,
      { name: 'dev', lifetime: 'persistent' },
      { operationId: 'op-cancel' }
    )
    expect(service.cancelCreate('op-cancel')).toBe(true)
    loading.release()
    await expect(created).rejects.toMatchObject({ code: 'cancelled' })
    expect(verbs()).not.toContain('create')
    expect(service.snapshots()[0]?.pendingCreates ?? []).toEqual([])
  })
})
