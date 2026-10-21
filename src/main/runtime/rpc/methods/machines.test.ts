import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { MACHINE_METHODS } from './machines'

const { getMachineService } = vi.hoisted(() => ({ getMachineService: vi.fn() }))
vi.mock('../../../machines/machine-service-registration', () => ({ getMachineService }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read no runtime member; only the reply envelope needs getRuntimeId.
const RUNTIME = { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService
const KEY = 'plugin:acme.omarchy/omarchy'

function dispatch(method: string, params?: unknown, options?: RpcDispatchStreamingOptions) {
  const request: RpcRequest = { id: 'machines-1', authToken: 'token', method, params }
  return new RpcDispatcher({ runtime: RUNTIME, methods: MACHINE_METHODS }).dispatch(
    request,
    options
  )
}

afterEach(() => getMachineService.mockReset())

describe('machines RPC', () => {
  it('offers only reads, wake and sleep; create, archive and delete stay desktop-local', () => {
    expect(MACHINE_METHODS.map((method) => method.name)).toEqual([
      'machines.list',
      'machines.get',
      'machines.wake',
      'machines.sleep'
    ])
  })

  it('reports unsupported where no service is registered or the flag is off', async () => {
    getMachineService.mockReturnValue(null)
    expect(await dispatch('machines.list', {})).toMatchObject({
      ok: true,
      result: { ok: false, code: 'unsupported' }
    })
  })

  it('refreshes through the cached list and forwards wake with typed failures', async () => {
    const service = {
      snapshots: vi.fn(() => [{ providerKey: KEY, name: 'Omarchy box', machines: [] }]),
      list: vi.fn(async () => ({ providerKey: KEY, name: 'Omarchy box', machines: [] })),
      wake: vi.fn(async () => {
        throw Object.assign(new Error('Permission denied'), { code: 'auth-required' })
      })
    }
    getMachineService.mockReturnValue(service)

    await dispatch('machines.list', { refresh: true })
    expect(service.list).toHaveBeenCalledWith(KEY, { maxAgeMs: 30_000 })

    expect(await dispatch('machines.wake', { providerKey: KEY, machineId: 'sbx-1' })).toMatchObject(
      { ok: true, result: { ok: false, message: 'Permission denied' } }
    )
  })

  it('rejects a machine id that is not a provider id', async () => {
    getMachineService.mockReturnValue({})
    expect(
      await dispatch('machines.sleep', { providerKey: KEY, machineId: '$(id)' })
    ).toMatchObject({ ok: false })
  })

  it("logs a paired device's wake by a short hash, never its device id", async () => {
    getMachineService.mockReturnValue({ wake: vi.fn(async () => ({ id: 'sbx-1' })) })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await dispatch(
      'machines.wake',
      { providerKey: KEY, machineId: 'sbx-1' },
      {
        pairedDeviceId: 'desktop-device-1'
      }
    )
    const line = String(info.mock.calls.at(-1)?.[0])
    expect(line).toMatch(/by device [0-9a-f]{8}\b/)
    expect(line).not.toContain('desktop-device-1')
    info.mockRestore()
  })

  it('lets a phone wake within the mobile scope, logged by a hash of its device id', async () => {
    const wake = vi.fn(async () => ({ id: 'sbx-1', state: 'running' }))
    getMachineService.mockReturnValue({ wake })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const phone: RpcDispatchStreamingOptions = {
      callerScope: { kind: 'mobile' },
      clientKind: 'mobile',
      pairedDeviceId: 'phone-1'
    }
    expect(
      await dispatch('machines.wake', { providerKey: KEY, machineId: 'sbx-1' }, phone)
    ).toMatchObject({ ok: true, result: { ok: true } })
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/by device [0-9a-f]{8}\b/))
    // The mobile scope reaches no machine verb beyond read, wake and sleep.
    expect(await dispatch('machines.create', { providerKey: KEY }, phone)).toMatchObject({
      ok: false
    })
    info.mockRestore()
  })
})
