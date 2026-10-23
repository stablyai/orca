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

function buildSetup(overrides: {
  id: string
  hostId: string
  repoId: string
  projectId?: string
  path?: string
  displayName?: string
}) {
  return {
    projectId: 'github:stablyai/orca',
    path: '/tmp/orca',
    displayName: 'Orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

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
      repoHostId: 'runtime:gpu',
      name: 'feature',
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

  it('surfaces a project.list failure instead of reporting the project as not set up', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [buildSetup({ id: 'setup-local', hostId: 'local', repoId: 'repo-local' })]
      })
    )
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('internal_error', 'project store offline')
    )

    await main(
      ['worktree', 'create', '--project', 'scalp-it', '--name', 'feature', '--no-parent', '--json'],
      '/tmp/repo'
    )

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('project store offline')
    expect(printed).not.toContain('Project is not set up')
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('refuses a legacy display-name match that spans two projects', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          buildSetup({
            id: 'setup-a',
            hostId: 'local',
            repoId: 'repo-a',
            projectId: 'github:acme/scalp-it',
            displayName: 'scalp-it'
          }),
          buildSetup({
            id: 'setup-b',
            hostId: 'local',
            repoId: 'repo-b',
            projectId: 'gitlab:other/scalp-it',
            displayName: 'scalp-it'
          })
        ]
      })
    )
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: project.list')
    )

    await main(
      ['worktree', 'create', '--project', 'scalp-it', '--name', 'feature', '--no-parent', '--json'],
      '/tmp/repo'
    )

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('2 projects have a setup named that')
    expect(printed).toContain('github:acme/scalp-it')
    expect(printed).toContain('gitlab:other/scalp-it')
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('falls back to the setup display name when the server has no project.list', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          buildSetup({
            id: 'setup-local',
            hostId: 'local',
            repoId: 'repo-local',
            projectId: 'github:stablyai/scalp-it',
            displayName: 'scalp-it'
          })
        ]
      })
    )
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: project.list')
    )
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/scalp-it/feature', 'feature', 'abc', 'repo-local'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--project', 'scalp-it', '--name', 'feature', '--no-parent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-local' })
    )
  })

  it('resolves --project by display name and infers the only host it is set up on', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          buildSetup({
            id: 'setup-local',
            hostId: 'local',
            repoId: 'repo-local',
            projectId: 'github:stablyai/scalp-it',
            path: '/tmp/scalp-it',
            displayName: 'scalp-it'
          })
        ]
      }),
      okFixture('req_projects', {
        projects: [{ id: 'github:stablyai/scalp-it', displayName: 'scalp-it' }]
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/scalp-it/feature', 'feature', 'abc', 'repo-local'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--project', 'scalp-it', '--name', 'feature', '--no-parent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'projectHostSetup.list')
    expect(callMock).toHaveBeenNthCalledWith(2, 'project.list')
    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-local' })
    )
  })

  it('reports an unknown project as a project miss, not a host one', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', { setups: [] }),
      okFixture('req_projects', { projects: [] })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--project', 'nope', '--name', 'feature', '--no-parent', '--json'],
      '/tmp/repo'
    )

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('No ready setup found for --project nope on any host.')
    expect(printed).not.toContain('selected host')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('asks which host only when the project is set up on more than one', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          buildSetup({
            id: 'setup-local',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/orca'
          }),
          buildSetup({
            id: 'setup-gpu',
            hostId: 'runtime:gpu',
            repoId: 'repo-gpu',
            path: '/srv/orca'
          })
        ]
      })
    )

    await main(
      [
        'worktree',
        'create',
        '--project',
        'github:stablyai/orca',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('it is set up on 2 hosts')
    expect(printed).toContain('--host local')
    expect(printed).toContain('--host runtime:gpu')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('accepts the host alias that `orca host list` prints', async () => {
    queueFixtures(
      callMock,
      okFixture('req_ssh_targets', {
        targets: [{ id: 'ssh-1783599077486-fyasux', label: 'trader-local' }]
      }),
      okFixture('req_project_setups', {
        setups: [
          buildSetup({ id: 'setup-local', hostId: 'local', repoId: 'repo-local' }),
          buildSetup({
            id: 'setup-trader',
            hostId: 'ssh:ssh-1783599077486-fyasux',
            repoId: 'repo-trader',
            path: '/home/trader/orca'
          })
        ]
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/home/trader/orca/feature', 'feature', 'abc', 'repo-trader'),
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
        'trader-local',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'ssh.listTargetSummaries')
    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-trader' })
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
