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

import { printHelp } from './help'
import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import type { RuntimeClient } from './runtime-client'
import { getTerminalHandle } from './selectors'
import { COMMAND_SPECS } from './specs'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'

function fakeClient(call: RuntimeClient['call']): RuntimeClient {
  return { call, isRemote: false } as unknown as RuntimeClient
}

describe('getTerminalHandle empty --terminal', () => {
  it('rejects an explicit empty handle without resolving the active pane', async () => {
    const call = vi.fn()
    await expect(
      getTerminalHandle(new Map([['terminal', '']]), '/tmp/repo', fakeClient(call))
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('non-empty handle')
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects a valueless --terminal flag without resolving the active pane', async () => {
    const call = vi.fn()
    await expect(
      getTerminalHandle(new Map([['terminal', true]]), '/tmp/repo', fakeClient(call))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('passes a whitespace handle through so the runtime can fail closed', async () => {
    const call = vi.fn()
    await expect(
      getTerminalHandle(new Map([['terminal', ' ']]), '/tmp/repo', fakeClient(call))
    ).resolves.toBe(' ')
    expect(call).not.toHaveBeenCalled()
  })

  it('resolves the worktree-active pane only when --terminal is omitted', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: { worktrees: [buildWorktree('/tmp/repo', 'main')] }
      })
      .mockResolvedValueOnce({ result: { handle: 'term_active' } })

    await expect(getTerminalHandle(new Map(), '/tmp/repo', fakeClient(call))).resolves.toBe(
      'term_active'
    )
    expect(call).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(call).toHaveBeenNthCalledWith(2, 'terminal.resolveActive', {
      worktree: 'id:repo::/tmp/repo'
    })
  })
})

describe('orca terminal empty --terminal', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  async function runEmptyHandle(argv: string[]): Promise<{ printed: unknown; exitCode: unknown }> {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    process.exitCode = 0
    await main(argv, '/tmp/repo')
    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? 'null'))
    const exitCode = process.exitCode
    process.exitCode = priorExitCode
    return { printed, exitCode }
  }

  it.each([
    ['show', ['terminal', 'show', '--terminal', '', '--json']],
    ['read', ['terminal', 'read', '--terminal', '', '--json']],
    ['wait', ['terminal', 'wait', '--terminal', '', '--for', 'tui-idle', '--json']],
    ['send', ['terminal', 'send', '--terminal', '', '--text', 'hi', '--json']]
  ])(
    'fails closed for empty --terminal on %s without contacting the runtime',
    async (_verb, argv) => {
      const { printed, exitCode } = await runEmptyHandle(argv)
      expect(exitCode).toBe(1)
      expect(printed).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: expect.stringContaining('Omit --terminal')
        }
      })
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('still targets the worktree-active pane when --terminal is omitted', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main')]),
      okFixture('req_resolve', { handle: 'term_active' }),
      okFixture('req_show', {
        terminal: { handle: 'term_active', title: 'shell', worktreePath: '/tmp/repo' }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'show', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('terminal.resolveActive', {
      worktree: 'id:repo::/tmp/repo'
    })
    expect(callMock).toHaveBeenCalledWith('terminal.show', { terminal: 'term_active' })
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      result: { terminal: { handle: 'term_active' } }
    })
  })

  it('documents that an empty --terminal is not omission', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printHelp(COMMAND_SPECS, ['terminal', 'read'])
    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('Omit --terminal to target the active terminal in the current worktree')
    expect(help).toContain('An empty --terminal is not omission and fails closed')
  })
})
