import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  resolveEnvironmentMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  spawnMock: vi.fn()
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

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  function reconciledRegistrations(stage: 'prepared' | 'catalog-active' = 'catalog-active') {
    const reconciliation = {
      version: 1,
      stage,
      requestId: 'reconcile',
      runtimeId: 'host',
      canonicalEnvironmentId: 'canonical',
      preparedAt: 1,
      registrations: ['canonical', 'historical'].map((environmentId) => ({
        environmentId,
        authorityDigest: 'a'.repeat(64)
      }))
    }
    return ['canonical', 'historical'].map((id) => ({
      ...addEnvironmentFromPairingCodeMock(),
      id,
      name: id,
      reconciliation
    }))
  }

  it.each(['environment', 'host'])(
    'lists one canonical host through %s list and retains historical IDs in JSON',
    async (command) => {
      const registrations = reconciledRegistrations()
      listEnvironmentsMock.mockReturnValue(registrations)
      callMock.mockResolvedValue({ result: { targets: [] }, _meta: { runtimeId: 'local' } })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await main([command, 'list', '--json'], '/tmp/repo')
      const output = String(log.mock.calls.at(-1)?.[0])
      const result = JSON.parse(output).result
      const environments =
        command === 'host'
          ? result.hosts.filter((entry: { kind: string }) => entry.kind === 'environment')
          : result.environments
      expect(environments).toHaveLength(1)
      expect(environments[0]).toMatchObject({
        id: 'canonical',
        historicalEnvironmentIds: ['historical']
      })
      expect(registrations).toHaveLength(2)
      expect(output).not.toContain('deviceToken')
      expect(output).not.toContain('publicKeyB64')
    }
  )

  it('keeps prepared registrations separately selectable', async () => {
    listEnvironmentsMock.mockReturnValue(reconciledRegistrations('prepared'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['environment', 'list', '--json'], '/tmp/repo')
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result.environments).toHaveLength(2)
  })

  it('shows the exact historical registration without substituting the canonical grant', async () => {
    const historical = reconciledRegistrations()[1]
    resolveEnvironmentMock.mockReturnValue(historical)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['environment', 'show', '--environment', 'historical', '--json'], '/tmp/repo')
    expect(resolveEnvironmentMock).toHaveBeenCalledWith('/tmp/orca-user-data', 'historical')
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).result.environment.id).toBe('historical')
  })

  it('lists saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    listEnvironmentsMock.mockReturnValue([addEnvironmentFromPairingCodeMock()])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'list', '--json'], '/tmp/repo')

    expect(listEnvironmentsMock).toHaveBeenCalledWith('/tmp/orca-user-data')
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })

  it('adds saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['environment', 'add', '--name', 'desk', '--pairing-code', 'orca://pair#abc', '--json'],
      '/tmp/repo'
    )

    expect(addEnvironmentFromPairingCodeMock).toHaveBeenCalledWith('/tmp/orca-user-data', {
      name: 'desk',
      pairingCode: 'orca://pair#abc'
    })
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })
})
