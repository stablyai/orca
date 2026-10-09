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
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'
import { RuntimeRpcFailureError } from './runtime-client'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('passes an exact branch separately from the workspace name and base ref', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/task', 'DAT-111-fix', 'abc', 'repo-1')
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
        'Fix login',
        '--branch',
        'DAT-111-fix',
        '--base-branch',
        'origin/main',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        name: 'Fix login',
        displayName: 'Fix login',
        branchNameOverride: 'DAT-111-fix',
        baseBranch: 'origin/main'
      })
    )
  })

  it.each([['--branch'], ['--branch', '']])(
    'rejects a missing branch value: %j',
    async (...branchFlags) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const priorExitCode = process.exitCode
      try {
        await main(
          [
            'worktree',
            'create',
            '--repo',
            'id:repo-1',
            '--name',
            'task',
            '--no-parent',
            '--json',
            ...branchFlags
          ],
          '/tmp/repo'
        )
        expect(callMock).not.toHaveBeenCalled()
        expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain('--branch')
        expect(process.exitCode).toBe(1)
      } finally {
        process.exitCode = priorExitCode
      }
    }
  )

  it('passes explicit activation through worktree.create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'feature', '--activate', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      displayName: 'feature',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: true,
      navigation: 'host',
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('resolves project and host flags to the matching repo for worktree.create', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-local',
            projectId: 'github:stablyai/orca',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/srv/orca/feature', 'feature', 'abc', 'repo-gpu'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--project',
        'github:stablyai/orca',
        '--host',
        'runtime:gpu',
        '--branch',
        'DAT-111-remote',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'gpu')
    expect(callMock).toHaveBeenNthCalledWith(1, 'projectHostSetup.list')
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-gpu',
      name: 'feature',
      branchNameOverride: 'DAT-111-remote',
      displayName: 'feature',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      noParent: true,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('resolves project-host-setup directly for worktree.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-gpu',
            projectId: 'github:stablyai/orca',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca',
            displayName: 'Orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/srv/orca/feature', 'feature', 'abc', 'repo-gpu'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--project-host-setup',
        'setup-gpu',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-gpu' })
    )
  })

  it('rejects mixing repo and project target flags on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-local',
        '--project',
        'github:stablyai/orca',
        '--name',
        'feature',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either --repo or project target flags, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes caller terminal handle through worktree.create with cwd fallback', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_parent'
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      displayName: 'child',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: 'term_parent',
      cliProvenanceRequest: { callerTerminalHandle: 'term_parent' }
    })
  })

  it('marks every worktree.create as CLI-created even from an external shell', async () => {
    // Why: the sidebar badge/filter must catch hand-typed creates too, so the
    // provenance request is sent with no terminal handle rather than omitted.
    delete process.env.ORCA_TERMINAL_HANDLE
    queueFixtures(
      callMock,
      okFixture('req_create_external', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--no-parent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ cliProvenanceRequest: {} })
    )
  })

  it('tells the user which --setup flag answers an undecided ask repo', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_create',
        ok: false,
        error: { code: 'runtime_error', message: 'Setup decision required for this repository' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--no-parent'],
      '/tmp/repo'
    )

    expect(errSpy.mock.calls.flat().join('\n')).toBe(
      'Setup decision required for this repository\n' +
        'Next step: Pass --setup run to run the setup script, or --setup skip to create without it.'
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
