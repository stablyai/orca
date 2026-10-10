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

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('passes Linear issue metadata through worktree.create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_linear', {
        worktree: {
          ...buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1'),
          linkedLinearIssue: 'STA-335',
          linkedLinearIssueWorkspaceId: null,
          linkedLinearIssueOrganizationUrlKey: 'stably'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'https://linear.app/stably/issue/STA-335/test-issue',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      displayName: 'feature',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: 'stably',
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('normalizes bare Linear identifiers through worktree.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create_linear_id', {
        worktree: {
          ...buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1'),
          linkedLinearIssue: 'STA-335'
        },
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'sta-335',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      displayName: 'feature',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      // Why: a bare identifier carries no org, and the two scoping fields
      // describe the issue being replaced. Inheriting a stale org key would
      // pin the lookup to a workspace this issue does not live in.
      linkedLinearIssueOrganizationUrlKey: null,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: true,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('rejects null Linear issue values on worktree.create before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'null',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Omit --linear-issue on create'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects invalid Linear issue values on worktree.create before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        'not-a-linear-link',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Pass a Linear issue identifier like STA-335'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects missing Linear issue values on worktree.create before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'feature',
        '--linear-issue',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --linear-issue'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
