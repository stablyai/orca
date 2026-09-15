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
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca quick-command worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  // Why: the runtime rejects the literal `active`, so the CLI must resolve the
  // cwd shortcut before it leaves the client.
  it('resolves --worktree active before calling the runtime', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_qc', { quickCommands: [], repoId: 'repo' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['quick-command', 'list', '--worktree', 'active', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'quickCommand.list', {
      repo: undefined,
      worktree: 'id:repo::/tmp/repo/feature',
      scope: undefined
    })
  })

  it('resolves --worktree active when creating a repo-scoped command', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_qc', { quickCommand: {}, quickCommands: [] })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'quick-command',
        'create',
        '--label',
        'Run tests',
        '--command',
        'pnpm test',
        '--worktree',
        'active',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'quickCommand.create',
      expect.objectContaining({ worktree: 'id:repo::/tmp/repo/feature' })
    )
  })
})
