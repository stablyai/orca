import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponseIfNeeded } from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  registerClientStateSettingsAccessor,
  runtimeClientState
} from './runtime-client-state-client'

const LOCAL = { activeRuntimeEnvironmentId: null }
const REMOTE = { activeRuntimeEnvironmentId: 'env-1' }

function stubRuntimeApi({
  localCall = vi.fn(),
  environmentCall = vi.fn()
}: {
  localCall?: ReturnType<typeof vi.fn>
  environmentCall?: ReturnType<typeof vi.fn>
}) {
  vi.stubGlobal('window', {
    api: {
      runtime: { call: localCall },
      runtimeEnvironments: { call: environmentCall }
    }
  })
  return { localCall, environmentCall }
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
  registerClientStateSettingsAccessor(() => null)
})

describe('runtimeClientState.get', () => {
  it('returns null when the RPC reports found: false', async () => {
    registerClientStateSettingsAccessor(() => LOCAL)
    const { localCall } = stubRuntimeApi({
      localCall: vi.fn().mockResolvedValue({ id: '1', ok: true, result: { found: false } })
    })

    const result = await runtimeClientState.get('keybindings')

    expect(result).toBeNull()
    expect(localCall).toHaveBeenCalledWith({
      method: 'clientState.get',
      params: { kind: 'keybindings' }
    })
  })

  it('parses stateJson into an object when found: true', async () => {
    registerClientStateSettingsAccessor(() => LOCAL)
    stubRuntimeApi({
      localCall: vi.fn().mockResolvedValue({
        id: '1',
        ok: true,
        result: { found: true, stateJson: JSON.stringify({ 'app.settings': ['cmd+,'] }) }
      })
    })

    const result = await runtimeClientState.get('keybindings')

    expect(result).toEqual({ 'app.settings': ['cmd+,'] })
  })

  it('routes through window.api.runtimeEnvironments.call for an active environment target', async () => {
    registerClientStateSettingsAccessor(() => REMOTE)
    const { environmentCall } = stubRuntimeApi({
      environmentCall: vi.fn().mockImplementation((args: { method: string }) => {
        return Promise.resolve(
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
            id: '1',
            ok: true,
            result: { found: false }
          }
        )
      })
    })

    await runtimeClientState.get('uiLocal')

    expect(environmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'clientState.get',
        params: { kind: 'uiLocal' }
      })
    )
  })
})

describe('runtimeClientState.set', () => {
  it('calls clientState.set with {kind, stateJson} for the local target', async () => {
    registerClientStateSettingsAccessor(() => LOCAL)
    const { localCall } = stubRuntimeApi({
      localCall: vi.fn().mockResolvedValue({ id: '1', ok: true, result: null })
    })

    await runtimeClientState.set('keybindings', { 'app.settings': ['cmd+,'] })

    expect(localCall).toHaveBeenCalledWith({
      method: 'clientState.set',
      params: { kind: 'keybindings', stateJson: JSON.stringify({ 'app.settings': ['cmd+,'] }) }
    })
  })

  it('routes through window.api.runtimeEnvironments.call for an active environment target', async () => {
    registerClientStateSettingsAccessor(() => REMOTE)
    const { environmentCall } = stubRuntimeApi({
      environmentCall: vi.fn().mockImplementation((args: { method: string }) => {
        return Promise.resolve(
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
            id: '1',
            ok: true,
            result: null
          }
        )
      })
    })

    await runtimeClientState.set('savedRuntimeEnvironments', [])

    expect(environmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'clientState.set',
        params: { kind: 'savedRuntimeEnvironments', stateJson: '[]' }
      })
    )
  })
})
