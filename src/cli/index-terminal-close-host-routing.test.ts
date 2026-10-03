import { describe, expect, it, vi } from 'vitest'

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

import { parseArgs, validateCommandAndFlags } from './args'
import { main } from './index'
import {
  pairRuntimeEnvironment,
  useWorktreeAwarenessEnvironment
} from './index-test-harness'
import { COMMAND_SPECS } from './specs'
import { okFixture, queueFixtures } from './test-fixtures'

describe('terminal close host routing', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('accepts --host on terminal close without an unknown-flag error', () => {
    const parsed = parseArgs([
      'terminal',
      'close',
      '--terminal',
      'term-1',
      '--host',
      'runtime:env-1'
    ])

    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
    expect(parsed.flags.get('host')).toBe('runtime:env-1')
  })

  it('routes terminal close --host runtime:<id> to that paired server', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-1')
    queueFixtures(
      callMock,
      okFixture('req_close', {
        close: { handle: 'term-1', tabId: 'tab-1', ptyKilled: true }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['terminal', 'close', '--terminal', 'term-1', '--host', 'runtime:env-1', '--json'],
      '/tmp/repo'
    )
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'env-1')
    expect(callMock).toHaveBeenCalledWith('terminal.close', { terminal: 'term-1' })
  })

  it('routes terminal close --worktree --all --host runtime:<id> to bulk close on that server', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-1')
    queueFixtures(
      callMock,
      okFixture('req_close_all', {
        closed: 1,
        stopped: 1,
        retiredSurfaces: true
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'close',
        '--worktree',
        'id:wt-1',
        '--all',
        '--host',
        'runtime:env-1',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'env-1')
    expect(callMock).toHaveBeenCalledWith('terminal.closeAll', { worktree: 'id:wt-1' })
  })

  it('propagates unverifiable stop failure from remote host as a failing exit code', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-1')
    queueFixtures(
      callMock,
      okFixture('req_close', {
        close: {
          handle: 'term-remote',
          tabId: 'tab-1',
          ptyKilled: false,
          ptyStopVerdict: 'unverifiable',
          ptyStopReason: 'its host could not be reached'
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    try {
      await main(
        ['terminal', 'close', '--terminal', 'term-remote', '--host', 'runtime:env-1', '--json'],
        '/tmp/repo'
      )
      expect(process.exitCode).toBe(1)
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
      expect(output.ok).toBe(false)
      expect(output.error.code).toBe('terminal_stop_unverifiable')
    } finally {
      process.exitCode = priorExitCode
    }
  })
})
