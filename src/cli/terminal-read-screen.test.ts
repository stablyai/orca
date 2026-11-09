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
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

function readFixture(overrides: Record<string, unknown> = {}) {
  return okFixture('req_terminal_read', {
    terminal: {
      handle: 'term_abc',
      status: 'running',
      tail: ['clear'],
      truncated: false,
      nextCursor: null,
      ...overrides
    }
  })
}

describe('orca terminal read --screen', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  // Older hosts strip the unknown screen key and return a stream read.
  it("refuses to pass an older host's stream off as a screen read", async () => {
    queueFixtures(callMock, readFixture({ tail: ['cclclecleaclear'] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['terminal', 'read', '--terminal', 'term_abc', '--screen', '--json'], '/tmp/repo')

    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'does not support --screen reads'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
