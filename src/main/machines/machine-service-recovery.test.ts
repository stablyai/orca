import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { MACHINE_CREATE_RECONCILE_WINDOW_MS } from '../../shared/machine-inventory'
import { getMachineInventoryStorePath } from './machine-inventory-store'
import { MachineService } from './machine-service'
import {
  KEY,
  fail,
  inventory,
  machine,
  removeMachineServiceRoots,
  reply,
  setup
} from './machine-service.test-fixture'

afterEach(removeMachineServiceRoots)

const PAIRING_CODE = encodePairingOffer({
  v: 2,
  endpoint: 'wss://sandbox.example.com',
  deviceToken: 'secret-device-token',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64')
})

describe('MachineService recovery', () => {
  it('never stores or returns a pairing code, only its hash', async () => {
    const orcaServer = machine({
      access: { kind: 'orca-server', pairingCode: PAIRING_CODE, projectRoot: '/w' }
    })
    const { service, userDataPath } = await setup({ get: reply(orcaServer) })
    const record = await service.get(KEY, 'sbx-1')
    expect(record.access).toMatchObject({ kind: 'orca-server', pairingCode: '' })
    expect(record.pairingCodeSha256).toMatch(/^[0-9a-f]{64}$/)
    const stored = await readFile(getMachineInventoryStorePath(userDataPath), 'utf8')
    expect(stored).not.toContain('secret-device-token')
    expect(stored).not.toContain(PAIRING_CODE)
  })

  it('retries a failed connect once when the provider reports a new endpoint', async () => {
    const moved = machine({
      access: { kind: 'ssh', host: 'omarchy', port: 42201, user: 'dev', projectRoot: '/home/dev' }
    })
    const { service, sshTargets, verbs } = await setup({
      list: inventory([machine()]),
      get: reply(moved)
    })
    vi.mocked(sshTargets.connect)
      .mockResolvedValueOnce({
        targetId: 't',
        status: 'error',
        error: 'refused',
        reconnectAttempt: 0
      })
      .mockResolvedValueOnce({
        targetId: 't',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    await service.list(KEY)
    await expect(service.connect(KEY, 'sbx-1')).resolves.toMatchObject({ kind: 'ssh' })
    expect(verbs().filter((verb) => verb === 'get')).toHaveLength(1)
    expect(sshTargets.connect).toHaveBeenCalledTimes(2)
  })

  it('does not retry when the endpoint is unchanged', async () => {
    const { service, sshTargets } = await setup({
      list: inventory([machine()]),
      get: reply(machine())
    })
    await service.list(KEY)
    await expect(service.connect(KEY, 'sbx-1')).rejects.toThrow('Connection refused')
    expect(sshTargets.connect).toHaveBeenCalledTimes(1)
  })

  it('finishes a timed-out delete the read confirms, removing the SSH target', async () => {
    const { service, removeSshTarget, verbs } = await setup({
      list: inventory([machine()]),
      delete: fail('timeout'),
      get: fail('not-found')
    })
    await service.list(KEY)
    expect((await service.delete(KEY, 'sbx-1')).state).toBe('gone')
    expect(verbs().filter((verb) => verb === 'delete')).toHaveLength(1)
    expect(removeSshTarget).toHaveBeenCalledTimes(1)
  })

  it('joins a retried create with the same operationId instead of starting another', async () => {
    let release: () => void = () => undefined
    const { service, verbs } = await setup({
      create: (args) =>
        new Promise((resolve) => {
          release = () => resolve(reply(machine({ creatingOperationId: args.operationId }))(args))
        })
    })
    const params = { name: 'dev', lifetime: 'persistent' as const }
    const first = service.create(KEY, params, { operationId: 'op-1' })
    const second = service.create(KEY, params, { operationId: 'op-1' })
    await vi.waitFor(() => expect(verbs()).toContain('create'))
    release()
    await Promise.all([first, second])
    expect(verbs().filter((verb) => verb === 'create')).toHaveLength(1)
    expect(service.snapshots()[0]?.pendingCreates).toEqual([])
  })

  it('starts a forced list after one already running instead of joining it', async () => {
    let releaseFirst: () => void = () => undefined
    const { service, verbs } = await setup({
      list: [
        (args) =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(inventory([])(args))
          }),
        inventory([machine()])
      ]
    })
    const first = service.list(KEY)
    await vi.waitFor(() => expect(verbs()).toContain('list'))
    const forced = service.list(KEY, { force: true })
    releaseFirst()
    await first
    expect((await forced).machines.map((record) => record.id)).toEqual(['sbx-1'])
    expect(verbs().filter((verb) => verb === 'list')).toHaveLength(2)
  })

  it('drops a pending create a list past the reconcile window cannot find', async () => {
    const { service, clock } = await setup({
      create: fail('timeout'),
      list: inventory([])
    })
    await service
      .create(KEY, { name: 'dev', lifetime: 'persistent' }, { operationId: 'op-lost' })
      .catch(() => undefined)
    expect(service.snapshots()[0]?.pendingCreates).toHaveLength(1)
    clock.now += MACHINE_CREATE_RECONCILE_WINDOW_MS + 1
    await service.list(KEY, { force: true })
    expect(service.snapshots()[0]?.pendingCreates).toEqual([])
  })

  it('never overwrites an inventory written by a newer build', async () => {
    const { deps, userDataPath } = await setup({ list: inventory([machine()]) })
    const newer = JSON.stringify({ version: 2, providers: {}, bindings: { w: {} } })
    await writeFile(getMachineInventoryStorePath(userDataPath), newer)
    const service = new MachineService(deps)
    await service.list(KEY)
    expect(service.snapshots()[0]?.machines).toHaveLength(1)
    expect(await readFile(getMachineInventoryStorePath(userDataPath), 'utf8')).toBe(newer)
  })
})
