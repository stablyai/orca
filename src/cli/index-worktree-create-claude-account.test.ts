import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY } from '../shared/protocol-version'

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
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
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

  it('sends the account selector to a host that advertises support', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', { capabilities: [CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY] }),
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/pinned', 'pinned', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([...createArgs, '--agent', 'claude', '--account', 'pinned@example.com'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'worktree.create',
      expect.objectContaining({
        startupAgent: 'claude',
        startupPrompt: '',
        startupClaudeAccount: 'pinned@example.com'
      })
    )
  })

  it('refuses an older host instead of launching on its active account', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main([...createArgs, '--agent', 'claude', '--account', 'acct-b'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
  })

  it('requires --agent claude', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main([...createArgs, '--agent', 'codex', '--account', 'acct-b'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalled()
  })
})
