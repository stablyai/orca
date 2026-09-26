import { afterEach, describe, expect, it, vi } from 'vitest'

const { callMock, runtimeClientConstructorMock, serveOrcaAppMock, getDefaultUserDataPathMock } =
  vi.hoisted(() => ({
    callMock: vi.fn(),
    runtimeClientConstructorMock: vi.fn(),
    serveOrcaAppMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

import { main } from './index'

describe('recovery commands stay local', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    callMock.mockReset()
    runtimeClientConstructorMock.mockReset()
    process.exitCode = 0
  })

  it('builds a local client even when remote selection env vars are set', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'remote-environment')
    vi.stubEnv('ORCA_PAIRING_CODE', 'remote-pairing-code')
    vi.stubEnv('ORCA_REMOTE_PAIRING', 'remote-pairing')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    callMock.mockResolvedValue({
      id: 'req-1',
      ok: true,
      result: { bindings: [] },
      _meta: { runtimeId: 'runtime-1' }
    })

    await main(['recovery', 'list', '--json'], '/work/repo')

    expect(process.exitCode).not.toBe(1)
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(callMock).toHaveBeenCalledWith('crossMachineRecovery.list', {})
  })

  it('ignores explicit remote selection flags', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    callMock.mockResolvedValue({
      id: 'req-2',
      ok: true,
      result: { descriptor: {} },
      _meta: { runtimeId: 'runtime-1' }
    })

    await main(
      ['recovery', 'export', '--worktree', 'path:/work/repo', '--environment', 'remote', '--json'],
      '/work/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(callMock).toHaveBeenCalledWith('crossMachineRecovery.export', {
      worktree: 'path:/work/repo'
    })
  })
})
