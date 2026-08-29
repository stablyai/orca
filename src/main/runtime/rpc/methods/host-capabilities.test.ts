import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const {
  isPwshAvailable,
  isPwshAvailableAsync,
  isWslAvailable,
  isWslAvailableAsync,
  listWslDistros,
  listWslDistrosAsync,
  isGitBashAvailable
} = vi.hoisted(() => ({
  isPwshAvailable: vi.fn(),
  isPwshAvailableAsync: vi.fn(),
  isWslAvailable: vi.fn(),
  isWslAvailableAsync: vi.fn(),
  listWslDistros: vi.fn(),
  listWslDistrosAsync: vi.fn(),
  isGitBashAvailable: vi.fn()
}))

vi.mock('../../../pwsh', () => ({ isPwshAvailable, isPwshAvailableAsync }))
vi.mock('../../../wsl', () => ({
  isWslAvailable,
  isWslAvailableAsync,
  listWslDistros,
  listWslDistrosAsync
}))
vi.mock('../../../git-bash', () => ({ isGitBashAvailable }))

import { HOST_CAPABILITY_METHODS } from './host-capabilities'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('host capability RPC methods', () => {
  beforeEach(() => {
    isPwshAvailable.mockReset()
    isPwshAvailableAsync.mockReset()
    isWslAvailable.mockReset()
    isWslAvailableAsync.mockReset()
    listWslDistros.mockReset()
    listWslDistrosAsync.mockReset()
    isGitBashAvailable.mockReset()
  })

  it('reports Windows shell capability probes through explicit methods', async () => {
    isPwshAvailableAsync.mockResolvedValue(true)
    isWslAvailableAsync.mockResolvedValue(true)
    listWslDistrosAsync.mockResolvedValue(['Ubuntu'])
    isGitBashAvailable.mockReturnValue(true)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOST_CAPABILITY_METHODS })

    await expect(dispatcher.dispatch(makeRequest('host.pwsh.isAvailable'))).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(dispatcher.dispatch(makeRequest('host.wsl.isAvailable'))).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(dispatcher.dispatch(makeRequest('host.wsl.listDistros'))).resolves.toMatchObject({
      ok: true,
      result: ['Ubuntu']
    })
    await expect(
      dispatcher.dispatch(makeRequest('host.gitBash.isAvailable'))
    ).resolves.toMatchObject({
      ok: true,
      result: true
    })
  })

  // Why: web/mobile clients reach these over the relay, so a sync probe would stall the
  // desktop main event loop on execFileSync wsl.exe/pwsh.exe for up to 5s per call.
  it('answers the Windows shell capability methods without a blocking spawn', async () => {
    isPwshAvailableAsync.mockResolvedValue(false)
    isWslAvailableAsync.mockResolvedValue(false)
    listWslDistrosAsync.mockResolvedValue([])
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOST_CAPABILITY_METHODS })

    await dispatcher.dispatch(makeRequest('host.wsl.isAvailable'))
    await dispatcher.dispatch(makeRequest('host.wsl.listDistros'))
    await dispatcher.dispatch(makeRequest('host.pwsh.isAvailable'))

    expect(isWslAvailableAsync).toHaveBeenCalledTimes(1)
    expect(listWslDistrosAsync).toHaveBeenCalledTimes(1)
    expect(isPwshAvailableAsync).toHaveBeenCalledTimes(1)
    expect(isWslAvailable).not.toHaveBeenCalled()
    expect(listWslDistros).not.toHaveBeenCalled()
    expect(isPwshAvailable).not.toHaveBeenCalled()
  })
})
