import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import type { RpcCallerScope } from './rpc-caller-scope'
import { codexMaintenanceOnHost } from '../../preflight/codex-maintenance-host'

vi.mock('../../preflight/codex-maintenance-host', () => ({
  codexMaintenanceOnHost: vi.fn()
}))

beforeEach(() => {
  vi.mocked(codexMaintenanceOnHost)
    .mockReset()
    .mockResolvedValue({
      installation: { status: 'ready', version: '0.136.0', minimumVersion: '0.136.0' },
      canRun: false,
      job: null
    })
})
afterEach(() => vi.restoreAllMocks())

function dispatcher() {
  const runtime = new OrcaRuntimeService()
  const settings = vi.spyOn(runtime, 'getCodexMaintenanceSettings').mockReturnValue({})
  return { instance: new RpcDispatcher({ runtime }), settings }
}

const REQUEST = {
  id: 'maintenance-start',
  authToken: 'unused',
  method: 'preflight.codexMaintenance',
  params: { operation: 'start' }
}

it.each([false, true])(
  'refuses a bridged SSH installation before the host runs it (remote control: %s)',
  async (remoteCliControl) => {
    const { instance, settings } = dispatcher()
    const callerScope: RpcCallerScope = {
      kind: 'ssh-bridge',
      targetId: 'box-1',
      remoteCliControl
    }
    const result = await instance.dispatch(REQUEST, { callerScope })
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(settings).not.toHaveBeenCalled()
    expect(codexMaintenanceOnHost).not.toHaveBeenCalled()
  }
)

it.each(['owner', 'runtime-paired'] as const)(
  'keeps explicit installation available to the %s UI',
  async (kind) => {
    const { instance } = dispatcher()
    const callerScope: RpcCallerScope = kind === 'owner' ? { kind } : { kind, grants: [] }
    const result = await instance.dispatch(REQUEST, { callerScope })
    expect(result.ok).toBe(true)
    expect(codexMaintenanceOnHost).toHaveBeenCalledExactlyOnceWith({ operation: 'start' }, {})
  }
)
