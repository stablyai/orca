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

describe('orca cli worktree import', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('sends `worktree import` and `worktree unimport` with the resolved selector', async () => {
    const worktree = { path: '/repo/.claude/worktrees/task' }
    queueFixtures(
      callMock,
      okFixture('req', { outcome: 'imported', worktree }),
      okFixture('req', { outcome: 'unimported', worktree })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'import', '--worktree', 'path:/repo/.claude/worktrees/task', '--json'],
      '/tmp/repo'
    )
    await main(
      ['worktree', 'unimport', '--worktree', 'path:/repo/.claude/worktrees/task', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.import', {
      worktree: 'path:/repo/.claude/worktrees/task'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.unimport', {
      worktree: 'path:/repo/.claude/worktrees/task'
    })
  })

  // Why: --host runtime:<id> routes to a paired server, so an older one is reachable without the
  // caller meaning to. A raw method_not_found reads as an Orca bug rather than a version gap.
  it('names the version gap when the server predates worktree import', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: worktree.import')
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'import', '--worktree', 'path:/repo/.claude/worktrees/task', '--json'],
      '/tmp/repo'
    )

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('does not support worktree import yet')
    expect(printed).not.toContain('Unknown method')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  // Why: outcome crosses the wire as a plain string, so a newer host can answer with a value this
  // build has never heard of. Printing that as success would claim an import that did not happen.
  it('does not report success for an outcome it does not recognize', async () => {
    queueFixtures(
      callMock,
      okFixture('req', {
        outcome: 'repo-readonly',
        worktree: { path: '/repo/.claude/worktrees/task' }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'import', '--worktree', 'path:/repo/.claude/worktrees/task'],
      '/tmp/repo'
    )

    const printed = logSpy.mock.calls.at(-1)?.[0]
    expect(printed).not.toContain('imported:')
    expect(printed).toContain('repo-readonly')
  })

  it('prints the import outcome and path in text mode', async () => {
    queueFixtures(
      callMock,
      okFixture('req', {
        outcome: 'already-imported',
        worktree: { path: '/repo/.claude/worktrees/task' }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'import', '--worktree', 'path:/repo/.claude/worktrees/task'],
      '/tmp/repo'
    )

    expect(logSpy.mock.calls.at(-1)?.[0]).toBe('already imported: /repo/.claude/worktrees/task')
  })
})
