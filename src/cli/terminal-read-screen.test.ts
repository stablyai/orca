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

  it('does not ask for a screen unless requested', async () => {
    queueFixtures(callMock, readFixture({ source: 'stream' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'read', '--terminal', 'term_abc', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.read',
      expect.not.objectContaining({ screen: true })
    )
  })

  it('requests the rendered screen with --screen', async () => {
    queueFixtures(callMock, readFixture({ source: 'screen' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'read', '--terminal', 'term_abc', '--screen', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.read',
      expect.objectContaining({ terminal: 'term_abc', screen: true })
    )
  })

  it('reports which question was answered in human output', async () => {
    queueFixtures(callMock, readFixture({ source: 'screen' }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'read', '--terminal', 'term_abc', '--screen'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0]?.[0])).toContain('source: screen')
  })

  // Why: the whole defect is a stream being read as if it were the screen. A fallback has to
  // announce itself rather than look like a successful screen read.
  it('warns when a screen was asked for but only the stream was available', async () => {
    queueFixtures(
      callMock,
      readFixture({ source: 'screen-unavailable', tail: ['cclclecleaclear'] })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'read', '--terminal', 'term_abc', '--screen'], '/tmp/repo')

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('no rendered screen was available')
    expect(printed).toContain('stacked fragments')
  })

  // Why: zod strips the unknown `screen` key on an older host, so it answers with an ordinary
  // stream read. Handing that back would be the original defect wearing the new flag's name.
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

  it('rejects --screen with --cursor instead of implying history that is not there', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['terminal', 'read', '--terminal', 'term_abc', '--screen', '--cursor', '42', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'has no cursor to page from'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
