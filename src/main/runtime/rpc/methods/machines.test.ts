import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { MACHINE_METHODS } from './machines'

const { getMachineService } = vi.hoisted(() => ({ getMachineService: vi.fn() }))
vi.mock('../../../machines/desktop-machine-service', () => ({ getMachineService }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read no runtime member; only the reply envelope needs getRuntimeId.
const RUNTIME = { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService
const KEY = 'plugin:acme.omarchy/omarchy'

function dispatch(method: string, params?: unknown) {
  const request: RpcRequest = { id: 'machines-1', authToken: 'token', method, params }
  return new RpcDispatcher({ runtime: RUNTIME, methods: MACHINE_METHODS }).dispatch(request)
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
})
