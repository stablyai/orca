import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY } from '../shared/account-runtime-capabilities'

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

vi.mock('./runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('./runtime/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

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
import {
  buildWorktree,
  okFixture,
  worktreeListFixture
} from './runtime/fixtures/runtime-rpc-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca worktree create --account', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  const createArgs = ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'pinned', '--json']

  function answerHost(capabilities: string[]): void {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.list') {
        return worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')])
      }
      if (method === 'status.get') {
        return okFixture('req_status', { capabilities })
      }
      if (method === 'worktree.create') {
        return okFixture('req_create', {
          worktree: buildWorktree('/tmp/repo/pinned', 'pinned', 'abc', 'repo-1')
        })
      }
      return okFixture('req_other', { folderWorkspaces: [], groups: [], repos: [] })
    })
  }

  it('sends the account selector to a host that advertises support', async () => {
    answerHost([CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([...createArgs, '--agent', 'claude', '--account', 'pinned@example.com'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('status.get')
    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        startupAgent: 'claude',
        startupPrompt: '',
        startupClaudeAccount: 'pinned@example.com'
      })
    )
  })

  it('refuses an older host instead of launching on its active account', async () => {
    answerHost([])
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main([...createArgs, '--agent', 'claude', '--account', 'acct-b'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
  })

  it('requires --agent claude', async () => {
    answerHost([])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main([...createArgs, '--agent', 'codex', '--account', 'acct-b'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect([...log.mock.calls, ...error.mock.calls].flat().join('\n')).toContain(
      '--account requires --agent claude'
    )
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
  })
})
