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

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

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
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: true,
      navigation: 'all',
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

  it('passes --branch through worktree.create as branchNameOverride', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: { id: 'repo-1', kind: 'git' } }),
      okFixture('req_status', { runtimeProtocolVersion: 3 }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/yoyo-prefix-test', 'yoyo/prefix-test', 'abc', 'repo-1'),
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
        'yoyo-prefix-test',
        '--branch',
        'yoyo/prefix-test',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'repo.show', { repo: 'id:repo-1' })
    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'worktree.create',
      expect.objectContaining({
        name: 'yoyo-prefix-test',
        branchNameOverride: 'yoyo/prefix-test',
        noParent: true
      })
    )
  })

  it('rejects --branch for folder workspace repos', async () => {
    const priorExitCode = process.exitCode
    process.exitCode = undefined
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: { id: 'folder-1', kind: 'folder' } })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:folder-1',
        '--name',
        'child',
        '--branch',
        'feature/x',
        '--no-parent',
        '--json'
      ],
      '/tmp/folder'
    )

    expect(callMock).toHaveBeenCalledWith('repo.show', { repo: 'id:folder-1' })
    expect(callMock.mock.calls.some((call) => call[0] === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--branch is only supported for git repositories'
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('rejects branch overrides before a legacy runtime can silently ignore them', async () => {
    const priorExitCode = process.exitCode
    process.exitCode = undefined
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: { id: 'repo-1', kind: 'git' } }),
      okFixture('req_status', { runtimeProtocolVersion: 2 }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/yoyo-prefix-test', 'yoyo-prefix-test', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'yoyo-prefix-test',
        '--branch',
        'yoyo/prefix-test',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock.mock.calls.some((call) => call[0] === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain('v1.4.5')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('uses slash-containing --name as branchNameOverride when --branch is omitted', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: { id: 'repo-1', kind: 'git' } }),
      okFixture('req_status', { appVersion: '1.4.5' }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/yoyo-prefix-test', 'yoyo/prefix-test', 'abc', 'repo-1'),
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
        'yoyo/prefix-test',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        name: 'yoyo/prefix-test',
        branchNameOverride: 'yoyo/prefix-test',
        noParent: true
      })
    )
  })

  it('omits an inferred branchNameOverride for folder workspace repos', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: { id: 'folder-1', kind: 'folder' } }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/folder/yoyo-prefix-test', '', 'abc', 'folder-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:folder-1',
        '--name',
        'yoyo/prefix-test',
        '--no-parent',
        '--json'
      ],
      '/tmp/folder'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'repo.show', { repo: 'id:folder-1' })
    const createCall = callMock.mock.calls.find((call) => call[0] === 'worktree.create')
    expect(createCall).toBeDefined()
    expect(createCall?.[1]).not.toHaveProperty('branchNameOverride')
  })

  it('treats whitespace-only --branch as absent for folder workspaces', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: { id: 'folder-1', kind: 'folder' } }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/folder/yoyo-prefix-test', '', 'abc', 'folder-1'),
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
        'id:folder-1',
        '--name',
        'yoyo/prefix-test',
        '--branch',
        '   ',
        '--no-parent',
        '--json'
      ],
      '/tmp/folder'
    )

    const createCall = callMock.mock.calls.find((call) => call[0] === 'worktree.create')
    expect(createCall).toBeDefined()
    expect(createCall?.[1]).not.toHaveProperty('branchNameOverride')
  })

  it('omits branchNameOverride for plain --name without --branch', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/plain-name', 'plain-name', 'abc', 'repo-1'),
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
        'plain-name',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    const createCall = callMock.mock.calls.find((call) => call[0] === 'worktree.create')
    expect(createCall).toBeDefined()
    expect(createCall?.[1]).not.toHaveProperty('branchNameOverride')
  })

  it('rejects --branch without a value on worktree.create', async () => {
    const priorExitCode = process.exitCode
    process.exitCode = undefined
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--branch', '--no-parent'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --branch'
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
})
