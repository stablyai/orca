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

const SSH_TARGET = { id: 'ssh-1777360569033-yvz2mp', label: 'openclaw', remotePlatform: 'win32' }

/** Every SSH-target lookup answers with the one target only this machine's runtime knows about. */
function queueSshTargetLookups(count: number): void {
  queueFixtures(
    callMock,
    ...Array.from({ length: count }, () => okFixture('req_ssh_targets', { targets: [SSH_TARGET] }))
  )
}

/**
 * A runtime that answers `status.get` with the name it currently publishes: the stored override
 * when one is set, else the detected name. `settings.update` replies with the real `{ settings }`
 * envelope so a handler reading a bare `machineName` off it prints `undefined`.
 */
function fakeMachineNameRuntime(detectedName: string): { updates: unknown[] } {
  const updates: unknown[] = []
  let override = ''
  callMock.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'status.get') {
      return okFixture('req_status', {
        machineName: override || detectedName,
        hostPlatform: 'darwin'
      })
    }
    if (method === 'settings.update') {
      updates.push(params)
      const requested =
        typeof params === 'object' && params !== null && 'machineName' in params
          ? params.machineName
          : ''
      override = String(requested).trim()
      return okFixture('req_settings', { settings: { machineName: override } })
    }
    throw new Error(`unexpected call ${method}`)
  })
  return { updates }
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
    expect(
      printed.result.hosts.find((host: { id: string }) => host.id === SSH_TARGET.id).platform
    ).toBe('win32')
    // The tell: `runtimeId: local` is only honest if no routed client was ever built.
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
  })

  it('reads and updates the name the answering runtime publishes', async () => {
    const runtime = fakeMachineNameRuntime('m4airs-Air')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'name', '--json'], '/tmp/repo')
    await main(['host', 'name', '--name', ' build-server ', '--json'], '/tmp/repo')
    await main(['host', 'name', '--name', '', '--json'], '/tmp/repo')
    await main(['host', 'name'], '/tmp/repo')

    const [first, second, third] = logSpy.mock.calls
      .slice(0, 3)
      .map((call) => JSON.parse(String(call[0])))
    expect(first.result).toEqual({ machineName: 'm4airs-Air', platform: 'darwin' })
    // The write reply is `{ settings }`; the printed name must be what the runtime publishes now.
    expect(second.result).toEqual({ machineName: 'build-server', platform: 'darwin' })
    expect(second._meta.runtimeId).toBe('runtime-1')
    // A blank `--name` returns to the detected name — and prints it, not an empty string.
    expect(third.result.machineName).toBe('m4airs-Air')
    expect(logSpy.mock.calls[3]?.[0]).toBe('m4airs-Air (darwin)')
    expect(runtime.updates).toEqual([{ machineName: ' build-server ' }, { machineName: '' }])
  })

  it('routes `host name --environment` and stamps the runtime that answered', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    fakeMachineNameRuntime('M4 Air')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    runtimeClientConstructorMock.mockClear()

    await main(['host', 'name', '--environment', 'm4air', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.ok).toBe(true)
    expect(printed.result.machineName).toBe('M4 Air')
    expect(printed._meta.runtimeId).toBe('runtime-1')
    expect(printed._meta.runtimeId).not.toBe('local')
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(undefined, 'm4air')
  })

  it('routes `host name` through an ambient ORCA_ENVIRONMENT, unlike the pinned `host list`', async () => {
    // Why: the pin used to cover the whole `host` family, which silently answered for this machine
    // when the shell was pointed at another one. `host name` describes one runtime, so it routes.
    process.env.ORCA_ENVIRONMENT = 'm4air'
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    fakeMachineNameRuntime('M4 Air')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    runtimeClientConstructorMock.mockClear()

    await main(['host', 'name', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.ok).toBe(true)
    expect(printed.result.machineName).toBe('M4 Air')
    expect(printed._meta.runtimeId).toBe('runtime-1')
    // The ambient selector is left for the client to honour; a `null` here would pin it local.
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(undefined, undefined)
    expect(runtimeClientConstructorMock).not.toHaveBeenCalledWith(null, null)
  })

  it('refuses to rename a runtime that does not publish a machine name', async () => {
    // Why: an older runtime's strict settings schema answers the write with a bare `invalid_params`;
    // the field's absence from status is the tell, so the CLI refuses before writing anything.
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    callMock.mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        return okFixture('req_status', { hostPlatform: 'darwin' })
      }
      throw new Error(`unexpected call ${method}`)
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['host', 'name', '--name', 'build-server', '--environment', 'm4air', '--json'],
      '/tmp/repo'
    )

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.ok).toBe(false)
    expect(printed.error.code).toBe('incompatible_runtime')
    expect(printed.error.message).toMatch(/does not support machine names/)
    expect(callMock).not.toHaveBeenCalledWith('settings.update', expect.anything())
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('reports an unreachable runtime as an error instead of inventing a name', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    callMock.mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'Orca is not running'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'name', '--json'], '/tmp/repo')

    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.ok).toBe(false)
    expect(printed.error.code).toBe('runtime_unavailable')
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it('rejects `host list --environment` instead of answering with a half-routed listing', async () => {
    // Why: pre-fix this routed the SSH lookup to m4air while reading paired servers from this
    // machine, dropped the openclaw row, and still stamped `_meta.runtimeId: "local"` — one
    // listing describing two hosts, which reads as "m4air has no SSH targets".
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-m4air', 'm4air')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    runtimeClientConstructorMock.mockClear()

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
