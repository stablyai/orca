import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  MACHINE_CREATE_RECONCILE_WINDOW_MS,
  type MachineProgressEvent
} from '../../shared/machine-inventory'
import { getMachineInventoryStorePath } from './machine-inventory-store'
import { MachineService } from './machine-service'
import { machineSshTargetId } from './machine-connect'
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
  it('never stores or returns a pairing code, and records no hash for an unpaired one', async () => {
    const orcaServer = machine({
      access: { kind: 'orca-server', pairingCode: PAIRING_CODE, projectRoot: '/w' }
    })
    const { service, userDataPath } = await setup({ get: reply(orcaServer) })
    const record = await service.get(KEY, 'sbx-1')
    expect(record.access).toMatchObject({ kind: 'orca-server', pairingCode: '' })
    expect(record.pairingCodeSha256).toBeUndefined()
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

  it('redials a just-woken machine while its sshd starts, but never past a key refusal', async () => {
    const { service, sshTargets, delay } = await setup({
      list: inventory([machine({ state: 'sleeping', access: undefined })]),
      wake: reply(machine())
    })
    const refused = { targetId: 't', status: 'error' as const, reconnectAttempt: 0 }
    vi.mocked(sshTargets.connect)
      .mockResolvedValueOnce({ ...refused, error: 'Connection closed by UNKNOWN port 65535' })
      .mockResolvedValueOnce({
        targetId: 't',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      .mockResolvedValueOnce({ ...refused, error: 'Host key verification failed for x.' })
    await service.list(KEY)
    await service.wake(KEY, 'sbx-1')
    await expect(service.connect(KEY, 'sbx-1')).resolves.toMatchObject({ kind: 'ssh' })
    expect(delay).toHaveBeenCalledWith(2_000)

    delay.mockClear()
    await expect(service.connect(KEY, 'sbx-1')).rejects.toThrow('Host key verification failed')
    expect(delay).not.toHaveBeenCalled()
  })

  it('lets dials to a waking machine wait for the wake, then redial in its start window', async () => {
    let finishWake: () => void = () => undefined
    const { service, starts, delay } = await setup({
      list: inventory([machine({ state: 'sleeping', access: undefined })]),
      wake: async (args) => {
        await new Promise<void>((resolve) => {
          finishWake = resolve
        })
        return reply(machine())(args)
      }
    })
    await service.list(KEY)
    const targetId = machineSshTargetId(KEY, 'sbx-1')
    const woken = service.wake(KEY, 'sbx-1')
    const dialed = vi.fn(async () => {
      if (dialed.mock.calls.length === 1) {
        throw new Error('Connection closed by UNKNOWN port 65535')
      }
    })
    const dial = starts.dial(targetId, dialed)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dialed).not.toHaveBeenCalled()
    finishWake()
    await woken
    await dial
    expect(dialed).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(2_000)
  })

  it('stops redialing a machine slept soon after it woke', async () => {
    const { service, starts, delay } = await setup({
      list: inventory([machine({ state: 'sleeping', access: undefined })]),
      wake: reply(machine()),
      sleep: reply(machine({ state: 'sleeping', access: undefined }))
    })
    await service.list(KEY)
    await service.wake(KEY, 'sbx-1')
    await service.sleep(KEY, 'sbx-1')
    const refused = vi.fn().mockRejectedValue(new Error('Connection reset by 127.0.0.1'))
    await expect(starts.dial(machineSshTargetId(KEY, 'sbx-1'), refused)).rejects.toThrow()
    expect(refused).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })

  it('keeps a deleted machine as gone with its managed server link for its worktrees', async () => {
    const { service, sshTargets } = await setup({
      list: [inventory([machine()]), inventory([])],
      delete: fail('not-found')
    })
    vi.mocked(sshTargets.connect).mockResolvedValueOnce({
      targetId: 't',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      managedServer: { kind: 'managed', environmentId: 'env-machine' }
    })
    await service.list(KEY)
    await service.connect(KEY, 'sbx-1')
    await service.delete(KEY, 'sbx-1')
    const snapshot = await service.list(KEY, { force: true })
    expect(snapshot.machines).toEqual([
      expect.objectContaining({ id: 'sbx-1', state: 'gone', managedEnvironmentId: 'env-machine' })
    ])
    expect(snapshot.machines[0]).not.toHaveProperty('sshTargetId', expect.anything())
  })

  it("retires a deleted machine's managed server once, keeping its row", async () => {
    const retired: string[] = []
    const { deps, sshTargets } = await setup({
      list: [inventory([machine()]), inventory([]), inventory([])],
      delete: fail('not-found')
    })
    const service = new MachineService({
      ...deps,
      isHostReferenced: () => true,
      retireEnvironment: (environmentId) => retired.push(environmentId)
    })
    vi.mocked(sshTargets.connect).mockResolvedValueOnce({
      targetId: 't',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      managedServer: { kind: 'managed', environmentId: 'env-machine' }
    })
    await service.list(KEY)
    await service.connect(KEY, 'sbx-1')
    expect(retired).toEqual([])
    await service.delete(KEY, 'sbx-1')
    await service.list(KEY, { force: true })
    await service.list(KEY, { force: true })
    expect(retired).toEqual(['env-machine'])
    expect(service.snapshots()[0]?.machines).toEqual([
      expect.objectContaining({ state: 'gone', managedEnvironmentId: 'env-machine' })
    ])
  })

  it('drops a gone row on the next list once no repo or workspace runs on its server', async () => {
    const referenced = new Set(['runtime:env-machine'])
    const { deps, sshTargets } = await setup({
      list: [inventory([machine()]), inventory([]), inventory([])],
      delete: fail('not-found')
    })
    const service = new MachineService({
      ...deps,
      isHostReferenced: (hostId) => referenced.has(hostId)
    })
    vi.mocked(sshTargets.connect).mockResolvedValueOnce({
      targetId: 't',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      managedServer: { kind: 'managed', environmentId: 'env-machine' }
    })
    await service.list(KEY)
    await service.connect(KEY, 'sbx-1')
    await service.delete(KEY, 'sbx-1')
    expect((await service.list(KEY, { force: true })).machines).toHaveLength(1)

    referenced.clear()
    expect((await service.list(KEY, { force: true })).machines).toEqual([])
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

  it('resolves a create only once the machine runs', async () => {
    const { service, delay } = await setup({
      create: (args) =>
        reply(
          machine({ state: 'creating', access: undefined, creatingOperationId: args.operationId })
        )(args),
      get: [reply(machine({ state: 'creating', access: undefined })), reply(machine())]
    })
    const record = await service.create(KEY, { name: 'dev', lifetime: 'persistent' })
    expect(record).toMatchObject({ state: 'running', access: { kind: 'ssh' } })
    expect(delay).toHaveBeenCalledWith(3_000)
  })

  it('tags wake progress with the caller operationId and machine', async () => {
    const events: MachineProgressEvent[] = []
    const { deps } = await setup({
      list: inventory([machine({ state: 'sleeping', access: undefined })]),
      wake: (args) => {
        args.onStderr?.('starting container\n')
        return reply(machine())(args)
      }
    })
    const tagged = new MachineService({ ...deps, onProgress: (event) => events.push(event) })
    await tagged.list(KEY)
    await tagged.wake(KEY, 'sbx-1', { operationId: 'op-wake' })
    expect(events).toEqual([
      {
        operationId: 'op-wake',
        providerKey: KEY,
        machineId: 'sbx-1',
        verb: 'wake',
        stream: 'stderr',
        chunk: 'starting container\n'
      }
    ])
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
