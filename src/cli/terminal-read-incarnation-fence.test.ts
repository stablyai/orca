import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { okFixture, queueFixtures } from './test-fixtures'
import { TERMINAL_READ_INCARNATION_FENCE_RUNTIME_CAPABILITY } from '../shared/protocol-version'

function guardedStatusFixture() {
  return okFixture('status', {
    capabilities: [TERMINAL_READ_INCARNATION_FENCE_RUNTIME_CAPABILITY]
  })
}

describe('orca terminal read incarnation fence', () => {
  let priorExitCode: typeof process.exitCode

  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  beforeEach(() => {
    priorExitCode = process.exitCode
    process.exitCode = 0
  })

  afterEach(() => {
    process.exitCode = priorExitCode
  })

  it('negotiates the capability and sends the exact guarded read identity', async () => {
    queueFixtures(
      callMock,
      guardedStatusFixture(),
      okFixture('read', {
        terminal: {
          handle: 'term_worker',
          incarnationId: 'inc-worker',
          worktreeId: 'repo::/tmp/worktree',
          status: 'running',
          tail: [],
          truncated: false,
          nextCursor: '42'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'read',
        '--terminal',
        'term_worker',
        '--expected-incarnation-id',
        'inc-worker',
        '--cursor',
        '42',
        '--limit',
        '100',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.read', {
      terminal: 'term_worker',
      expectedIncarnationId: 'inc-worker',
      cursor: 42,
      limit: 100
    })
    expect(process.exitCode).toBe(0)
  })

  it('does not read from a runtime without the fence capability', async () => {
    queueFixtures(callMock, okFixture('status', { capabilities: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'read',
        '--terminal',
        'term_worker',
        '--expected-incarnation-id',
        'inc-worker',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('status.get')
    expect([...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n')).toContain(
      'incompatible_runtime'
    )
    expect(process.exitCode).toBe(1)
  })

  it('does not read when capability status lacks a runtime identity', async () => {
    const malformedStatus = guardedStatusFixture()
    Reflect.deleteProperty(malformedStatus, '_meta')
    callMock.mockResolvedValueOnce(malformedStatus)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'read',
        '--terminal',
        'term_worker',
        '--expected-incarnation-id',
        'inc-worker',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('status.get')
    expect([...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n')).toContain(
      'terminal_handle_stale'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects an explicitly empty incarnation fence before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['terminal', 'read', '--terminal', 'term_worker', '--expected-incarnation-id', '', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n')).toContain(
      '--expected-incarnation-id must not be empty'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects a guarded response without runtime metadata before printing output', async () => {
    const responseFixture = okFixture('read', {
      terminal: {
        handle: 'term_worker',
        incarnationId: 'inc-worker',
        worktreeId: 'repo::/wt',
        status: 'running',
        tail: ['must-not-print'],
        truncated: false,
        nextCursor: null
      }
    })
    Reflect.deleteProperty(responseFixture, '_meta')
    queueFixtures(callMock, guardedStatusFixture(), responseFixture)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'read',
        '--terminal',
        'term_worker',
        '--expected-incarnation-id',
        'inc-worker',
        '--json'
      ],
      '/tmp/repo'
    )

    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n')
    expect(callMock).toHaveBeenCalledTimes(2)
    expect(output).toContain('terminal_handle_stale')
    expect(output).not.toContain('must-not-print')
    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['runtime mismatch', true, { incarnationId: 'inc-worker', worktreeId: 'repo::/wt' }],
    ['missing incarnation', false, { worktreeId: 'repo::/wt' }],
    ['missing worktree', false, { incarnationId: 'inc-worker' }],
    [
      'handle mismatch',
      false,
      {
        handle: 'term_replacement',
        incarnationId: 'inc-worker',
        worktreeId: 'repo::/wt'
      }
    ],
    ['identity mismatch', false, { incarnationId: 'inc-replacement', worktreeId: 'repo::/wt' }]
  ])('rejects a guarded response with %s', async (_name, runtimeMismatch, responseIdentity) => {
    const statusFixture = guardedStatusFixture()
    const responseFixture = okFixture('read', {
      terminal: {
        handle: 'term_worker',
        ...responseIdentity,
        status: 'running',
        tail: ['must-not-print'],
        truncated: false,
        nextCursor: null
      }
    })
    responseFixture._meta.runtimeId = runtimeMismatch
      ? `${statusFixture._meta.runtimeId}-replacement`
      : statusFixture._meta.runtimeId
    queueFixtures(callMock, statusFixture, responseFixture)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'read',
        '--terminal',
        'term_worker',
        '--expected-incarnation-id',
        'inc-worker',
        '--json'
      ],
      '/tmp/repo'
    )

    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n')
    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.read', {
      terminal: 'term_worker',
      expectedIncarnationId: 'inc-worker'
    })
    expect(output).toContain('terminal_handle_stale')
    expect(output).not.toContain('must-not-print')
    expect(process.exitCode).toBe(1)
  })
})
