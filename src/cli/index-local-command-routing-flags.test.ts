import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  removeEnvironmentMock,
  resolveEnvironmentMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  removeEnvironmentMock: vi.fn(),
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
  removeEnvironment: removeEnvironmentMock,
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

const SSH_TARGET = { id: 'ssh-1777360569033-yvz2mp', label: 'openclaw' }

/** Every SSH-target lookup answers with the one target only this machine's runtime knows about. */
function queueSshTargetLookups(count: number): void {
  queueFixtures(
    callMock,
    ...Array.from({ length: count }, () => okFixture('req_ssh_targets', { targets: [SSH_TARGET] }))
  )
}

describe('runtime-selector flags on locally pinned CLI commands', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('answers `host list` from this machine and stamps the runtime that actually answered', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    queueSshTargetLookups(1)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'list', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed._meta.runtimeId).toBe('local')
    expect(printed.result.hosts.map((host: { id: string }) => host.id)).toEqual([
      'local',
      SSH_TARGET.id,
      'env-m4air'
    ])
    // The tell: `runtimeId: local` is only honest if no routed client was ever built.
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
  })

  it('rejects `host list --environment` instead of answering with a half-routed listing', async () => {
    // Why: pre-fix this routed the SSH lookup to m4air while reading paired servers from this
    // machine, dropped the openclaw row, and still stamped `_meta.runtimeId: "local"` — one
    // listing describing two hosts, which reads as "m4air has no SSH targets".
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'list', '--environment', 'm4air', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.ok).toBe(false)
    expect(printed.error.code).toBe('invalid_argument')
    expect(printed.error.message).toContain('`--environment` does not retarget `orca host list`')
    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalled()
    expect(runtimeClientConstructorMock).not.toHaveBeenCalledWith(null, 'm4air')
    process.exitCode = 0
  })

  it('rejects `environment list --environment` rather than repeating the local answer', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'list', '--environment', 'm4air', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.ok).toBe(false)
    expect(printed.error.code).toBe('invalid_argument')
    expect(printed.error.message).toContain(
      '`--environment` does not retarget `orca environment list`'
    )
    process.exitCode = 0
  })

  it('rejects `--pairing-code` on both listings for the same reason', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'list', '--pairing-code', 'orca://pair?code=x', '--json'], '/tmp/repo')
    await main(
      ['environment', 'list', '--pairing-code', 'orca://pair?code=x', '--json'],
      '/tmp/repo'
    )

    for (const call of logSpy.mock.calls) {
      const printed = JSON.parse(String(call[0]))
      expect(printed.ok).toBe(false)
      expect(printed.error.message).toContain('`--pairing-code` does not retarget')
    }
    expect(callMock).not.toHaveBeenCalled()
    process.exitCode = 0
  })

  it('keeps `host list` local when ORCA_ENVIRONMENT is set ambiently', async () => {
    // Why: the ambient variable produced the same two-machine listing as the explicit flag, with
    // no flag to reject. Pinning the family is what makes `runtimeId: local` true in both cases.
    process.env.ORCA_ENVIRONMENT = 'm4air'
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    queueSshTargetLookups(1)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'list', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.ok).toBe(true)
    expect(printed.result.hosts.some((host: { id: string }) => host.id === SSH_TARGET.id)).toBe(
      true
    )
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(runtimeClientConstructorMock).not.toHaveBeenCalledWith(undefined, undefined)
  })

  it('still treats --environment as the selector argument on `environment show` and `rm`', async () => {
    // Why: the guard must not fire where the flag names the row to act on rather than a route.
    const environment = {
      id: 'env-m4air',
      name: 'm4air',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: null
    }
    resolveEnvironmentMock.mockReturnValue(environment)
    removeEnvironmentMock.mockReturnValue(environment)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'show', '--environment', 'm4air', '--json'], '/tmp/repo')
    await main(['environment', 'rm', '--environment', 'm4air', '--json'], '/tmp/repo')

    for (const call of logSpy.mock.calls) {
      expect(JSON.parse(String(call[0])).ok).toBe(true)
    }
  })
})
