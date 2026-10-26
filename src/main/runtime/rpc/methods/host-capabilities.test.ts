import '../unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const {
  isPwshAvailable,
  isPwshAvailableAsync,
  isWslAvailableAsync,
  listWslDistros,
  listWslDistrosAsync,
  isGitBashAvailable,
  resolveNiubashPath
} = vi.hoisted(() => ({
  isPwshAvailable: vi.fn(),
  isPwshAvailableAsync: vi.fn(),
  isWslAvailableAsync: vi.fn(),
  listWslDistros: vi.fn(),
  listWslDistrosAsync: vi.fn(),
  isGitBashAvailable: vi.fn(),
  resolveNiubashPath: vi.fn()
}))

vi.mock('../../../pwsh', () => ({ isPwshAvailable, isPwshAvailableAsync }))
vi.mock('../../../wsl', () => ({
  isWslAvailableAsync,
  listWslDistros,
  listWslDistrosAsync
}))
vi.mock('../../../git-bash', () => ({ isGitBashAvailable }))
vi.mock('../../../niubash', () => ({ resolveNiubashPath }))

import { HOST_CAPABILITY_METHODS } from './host-capabilities'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('host capability RPC methods', () => {
  beforeEach(() => {
    isPwshAvailable.mockReset()
    isPwshAvailableAsync.mockReset()
    isWslAvailableAsync.mockReset()
    listWslDistros.mockReset()
    listWslDistrosAsync.mockReset()
    isGitBashAvailable.mockReset()
    resolveNiubashPath.mockReset()
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

  it.each([null, 'D:\\Niu Shell\\niu.exe'])(
    'reports Niubash from this execution host (%s)',
    async (path) => {
      resolveNiubashPath.mockReturnValue(path)
      const method = HOST_CAPABILITY_METHODS.find(
        (entry) => entry.name === 'host.niubash.isAvailable'
      )
      expect(method).toBeDefined()
      const runtime = { getRuntimeId: () => 'test-runtime' }
      const dispatcher = new RpcDispatcher({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the runtime id is used by this capability handler's dispatcher.
        runtime: runtime as OrcaRuntimeService,
        methods: HOST_CAPABILITY_METHODS
      })
      await expect(
        dispatcher.dispatch(makeRequest('host.niubash.isAvailable'))
      ).resolves.toMatchObject({ ok: true, result: path !== null })
    }
  )

  // Paired capability reads must not block the main loop with synchronous wsl.exe/pwsh.exe probes (up to 5s).
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
    expect(listWslDistros).not.toHaveBeenCalled()
    expect(isPwshAvailable).not.toHaveBeenCalled()
  })
})
