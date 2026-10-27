import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeEnvironment, resolveEnvironment } = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment }))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment
}))

import { callRuntimeSessionSearch, bindRuntimeSessionSearch } from './runtime-session-search-call'

beforeEach(() => {
  callRuntimeEnvironment.mockReset()
})

describe('runtime session search transport', () => {
  it('addresses the environment by method and params and returns its result', async () => {
    callRuntimeEnvironment.mockResolvedValue({ id: '1', ok: true, result: { kind: 'ok' } })
    expect(
      await callRuntimeSessionSearch('/user/data', 'env-1', 'aiVault.searchSessions', {
        query: 'needle'
      })
    ).toEqual({ kind: 'ok' })
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user/data',
      'env-1',
      'aiVault.searchSessions',
      { query: 'needle' }
    )
  })
  it('rethrows a refusal with its code so an old host reads as an absent method', async () => {
    callRuntimeEnvironment.mockResolvedValue({
      id: '1',
      ok: false,
      error: { code: 'method_not_found', message: 'unknown method' }
    })
    await expect(
      callRuntimeSessionSearch('/user/data', 'env-1', 'aiVault.searchSessions', {})
    ).rejects.toMatchObject({ code: 'method_not_found', message: 'unknown method' })
  })
})

it('captures the selected pairing/runtime before status and reuses it for search and continuation', async () => {
  const selected = { id: 'env-1', createdAt: 1, pairingRevision: 7, runtimeId: 'runtime-a' }
  resolveEnvironment.mockReturnValue(selected)
  const call = bindRuntimeSessionSearch('/user/data', 'env-1')
  selected.pairingRevision = 8
  selected.runtimeId = 'runtime-b'
  callRuntimeEnvironment.mockResolvedValue({ ok: true, result: {} })
  for (const [method, params] of [
    ['aiVault.searchStatus', {}],
    [
      'aiVault.searchSessions',
      {
        query: 'needle',
        within: { kind: 'project', projectKey: 'project:P', canonicalProjectKey: 'repo:b' }
      }
    ],
    ['aiVault.searchSessions', { query: 'needle', cursor: 'next' }]
  ] as const) {
    await call(method, params)
    expect(callRuntimeEnvironment).toHaveBeenLastCalledWith(
      '/user/data',
      'env-1',
      method,
      params,
      undefined,
      7,
      undefined,
      { expectedEnvironmentRuntimeId: 'runtime-a' }
    )
  }
  expect(resolveEnvironment).toHaveBeenCalledOnce()
})
