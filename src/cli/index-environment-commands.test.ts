import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
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
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const localOnlyCommands = [
  ['environment list', ['environment', 'list']],
  ['host list', ['host', 'list']]
] as const

describe('orca cli worktree awareness', () => {
  beforeEach(() => {
    process.exitCode = 0
  })

  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('lists saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    process.env.ORCA_PAIRING_CODE = 'stale-pairing-code'
    listEnvironmentsMock.mockReturnValue([addEnvironmentFromPairingCodeMock()])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'list', '--json'], '/tmp/repo')

    expect(listEnvironmentsMock).toHaveBeenCalledWith('/tmp/orca-user-data')
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })

  it.each(
    localOnlyCommands.flatMap(([command, argv]) =>
      ['environment', 'pairing-code'].map((flag) => [command, argv, flag] as const)
    )
  )('rejects explicit --%s for %s before runtime access', async (command, argv, flag) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main([...argv, `--${flag}`, 'remote-host'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(
      `\`--${flag}\` does not retarget \`orca ${command}\``
    )
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('keeps host list local when ambient remote selectors are set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-environment'
    process.env.ORCA_PAIRING_CODE = 'stale-pairing-code'
    callMock.mockResolvedValue({
      id: 'local',
      ok: true,
      result: { targets: [] },
      _meta: { runtimeId: 'local' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['host', 'list', '--json'], '/tmp/repo')

    expect(process.exitCode).not.toBe(1)
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(callMock).toHaveBeenCalledWith('ssh.listTargetSummaries')
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
