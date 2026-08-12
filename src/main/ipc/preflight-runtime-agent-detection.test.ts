import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getCanonicalUserDataPathMock, resolveEnvironmentMock, callRuntimeEnvironmentMock } =
  vi.hoisted(() => ({
    getCanonicalUserDataPathMock: vi.fn(),
    resolveEnvironmentMock: vi.fn(),
    callRuntimeEnvironmentMock: vi.fn()
  }))

vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: getCanonicalUserDataPathMock
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { detectRuntimeAgents } from './preflight-runtime-agent-detection'

describe('detectRuntimeAgents', () => {
  beforeEach(() => {
    getCanonicalUserDataPathMock.mockReset()
    resolveEnvironmentMock.mockReset()
    callRuntimeEnvironmentMock.mockReset()
    getCanonicalUserDataPathMock.mockReturnValue('/user-data')
    resolveEnvironmentMock.mockReturnValue({ id: 'env-1' })
  })

  it('proxies preflight.detectAgents to a known runtime environment', async () => {
    callRuntimeEnvironmentMock.mockResolvedValueOnce({
      ok: true,
      result: ['pi', 'claude', 'pi']
    })

    await expect(detectRuntimeAgents({ environmentId: 'env-1' })).resolves.toEqual(['pi', 'claude'])
    expect(resolveEnvironmentMock).toHaveBeenCalledWith('/user-data', 'env-1')
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'preflight.detectAgents',
      undefined
    )
  })

  it('returns no agents for an unknown or unpaired environment', async () => {
    resolveEnvironmentMock.mockImplementationOnce(() => {
      throw new Error('Unknown environment: env-missing')
    })

    await expect(detectRuntimeAgents({ environmentId: 'env-missing' })).resolves.toEqual([])
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })

  it('returns no agents when the runtime is unreachable', async () => {
    callRuntimeEnvironmentMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'runtime_unavailable', message: 'offline' }
    })

    await expect(detectRuntimeAgents({ environmentId: 'env-1' })).resolves.toEqual([])
  })

  it('returns no agents when the transport throws', async () => {
    callRuntimeEnvironmentMock.mockRejectedValueOnce(new Error('timeout'))

    await expect(detectRuntimeAgents({ environmentId: 'env-1' })).resolves.toEqual([])
  })

  it('never re-delegates via detectRuntimeAgents (loop prevention)', async () => {
    callRuntimeEnvironmentMock.mockResolvedValueOnce({ ok: true, result: ['codex'] })

    await detectRuntimeAgents({ environmentId: 'env-1' })

    const [, , method] = callRuntimeEnvironmentMock.mock.calls[0]!
    expect(method).toBe('preflight.detectAgents')
    expect(method).not.toBe('preflight.detectRuntimeAgents')
  })

  it('ignores blank environment ids without contacting the store', async () => {
    await expect(detectRuntimeAgents({ environmentId: '   ' })).resolves.toEqual([])
    expect(resolveEnvironmentMock).not.toHaveBeenCalled()
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
  })
})
