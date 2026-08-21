import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveMCodeAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveMCodeAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/mcode-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveMCodeAppMock,
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
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('mcode cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveMCodeAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('resolves repo.add paths against the invoking cli cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: path.resolve('/tmp/repo/apps/web'),
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'add', '--path', './apps/web', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: path.resolve('/tmp/repo/apps/web')
    })
  })

  it('lists projects through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_list', {
        projects: [
          {
            id: 'github:mcode-ide/mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            providerIdentity: {
              provider: 'github',
              owner: 'stablyai',
              repo: 'mcode'
            },
            sourceRepoIds: ['repo-1'],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'list', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('project.list')
  })

  it('routes a runtime host filter to that paired server and keeps its own local rows', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-local',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'local',
            repoId: 'repo-local',
            path: '/tmp/mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-remote',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:gpu',
            repoId: 'repo-remote',
            path: '/srv/mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'setups', '--project', 'github:mcode-ide/mcode', '--host', 'runtime:gpu'],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'gpu')
    expect(callMock).toHaveBeenCalledWith('projectHostSetup.list')
    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-remote')
    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-local')
  })

  it('keeps --host local a filter on the selected environment rather than a second selector', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'prod')
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-on-box',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'local',
            repoId: 'repo-on-box',
            path: '/srv/mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-by-client',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:prod',
            repoId: 'repo-by-client',
            path: '/srv/mcode-2',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'setups', '--environment', 'prod', '--host', 'local'], '/tmp/repo')

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(undefined, 'prod')
    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-on-box')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('setup-by-client')
  })

  // Why: --host runtime:<id> routes to a paired server, so an older one is reachable without the
  // caller meaning to. A raw method_not_found reads as an MCode bug rather than a version gap.
  it('names the version gap when the server predates project host setup', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'old-server')
    const { RuntimeClientError } = await import('./runtime/types.js')
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: projectHostSetup.list')
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['project', 'setups', '--host', 'runtime:old-server', '--json'], '/tmp/repo')

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('does not support project host setup yet')
    expect(printed).not.toContain('Unknown method')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects a runtime host id that no paired server owns instead of answering empty', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['project', 'setups', '--host', 'runtime:not-a-real-env', '--json'], '/tmp/repo')

    // The command itself never reached a runtime; only the suggestion lookup did.
    expect(callMock).not.toHaveBeenCalledWith('projectHostSetup.list')
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('no paired MCode server is named or has id not-a-real-env')
    // An agent reads the code and the retry candidates, not the prose.
    expect(JSON.parse(printed).error.code).toBe('invalid_argument')
    expect(JSON.parse(printed).error.data.knownEnvironments).toEqual([])
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  // Why: ssh: was never validated, so an unknown target answered ok:true with an empty list —
  // the same silent wrong-machine answer unknown runtime ids used to give.
  it('rejects an unknown ssh host instead of answering empty', async () => {
    queueFixtures(callMock, okFixture('req_ssh_targets', { targets: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['project', 'setups', '--host', 'ssh:openclaw', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalledWith('projectHostSetup.list')
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'no SSH target named or with id openclaw'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('tells a caller reaching for a paired server by ssh that it is an environment', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'awin')
    queueFixtures(callMock, okFixture('req_ssh_targets', { targets: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['project', 'setups', '--host', 'ssh:awin', '--json'], '/tmp/repo')

    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--environment awin'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('resolves an ssh label to its target id before filtering', async () => {
    queueFixtures(
      callMock,
      okFixture('req_ssh_targets', { targets: [{ id: 'ssh-123-abc', label: 'openclaw' }] }),
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-openclaw',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'ssh:ssh-123-abc',
            repoId: 'repo-openclaw',
            path: '/home/me/mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'setups', '--host', 'ssh:openclaw'], '/tmp/repo')

    expect(logSpy.mock.calls[0]?.[0]).toContain('setup-openclaw')
  })

  // Why: `runtime:<id>` is a persisted token — it lands in ProjectHostSetup.hostId and is
  // embedded in generated setup ids. Accepting a name is only safe because it is canonicalized
  // to the id before anything downstream sees it; this pins that.
  it('never lets an environment name reach a persisted host id', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-uuid-1', 'awin')
    queueFixtures(
      callMock,
      okFixture('req_project_setup_create', {
        result: {
          project: {
            id: 'github:mcode-ide/mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-awin',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'local',
            repoId: '',
            path: '',
            displayName: 'awin',
            setupState: 'setting-up',
            setupMethod: 'provisioned',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-create',
        '--project',
        'github:mcode-ide/mcode',
        '--host',
        'runtime:awin',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'env-uuid-1')
    expect(callMock).toHaveBeenCalledWith(
      'projectHostSetup.create',
      expect.objectContaining({ hostId: 'runtime:env-uuid-1' })
    )
  })

  it('rejects a malformed --host value before contacting any runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['project', 'setups', '--host', 'runtime:', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Invalid --host value: runtime:'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('refuses a runtime host id alongside an unrelated --pairing-code connection', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['project', 'setups', '--host', 'runtime:gpu', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'use either --host runtime:<id> or --pairing-code, not both'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('sets up an existing project folder with a path resolved against the local cli cwd', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup', {
        result: {
          project: {
            id: 'github:mcode-ide/mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            sourceRepoIds: ['repo-1'],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-local',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'local',
            repoId: 'repo-1',
            path: path.resolve('/tmp/mcode'),
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 1
          },
          repo: {
            id: 'repo-1',
            path: path.resolve('/tmp/mcode'),
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            addedAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-existing-folder',
        '--project',
        'github:mcode-ide/mcode',
        '--host',
        'local',
        '--path',
        '..',
        '--kind',
        'git',
        '--display-name',
        'MCode',
        '--json'
      ],
      '/tmp/mcode/worktrees/feature'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.setupExistingFolder', {
      projectId: 'github:mcode-ide/mcode',
      hostId: 'local',
      path: path.resolve('/tmp/mcode/worktrees'),
      kind: 'git',
      displayName: 'MCode'
    })
  })

  it('rejects remote project setup relative paths instead of resolving against client cwd', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'project',
        'setup-existing-folder',
        '--project',
        'github:mcode-ide/mcode',
        '--host',
        'runtime:gpu',
        '--path',
        './mcode',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Remote project setup requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects remote repo.add relative paths instead of resolving against client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['repo', 'add', '--path', './apps/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Remote repo add requires --path to be an absolute path on the remote server.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('sends remote repo.add absolute paths unchanged', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_add', {
        repo: {
          id: 'repo-1',
          path: '/srv/mcode/web',
          displayName: 'web'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['repo', 'add', '--path', '/srv/mcode/web', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('repo.add', {
      path: '/srv/mcode/web'
    })
  })

  it.each(['C:\\repo', 'C:/repo', '\\\\server\\share\\repo', '//server/share/repo'])(
    'sends remote repo.add server absolute path %s unchanged',
    async (serverPath) => {
      queueFixtures(
        callMock,
        okFixture('req_repo_add', {
          repo: {
            id: 'repo-1',
            path: serverPath,
            displayName: 'web'
          }
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(
        ['repo', 'add', '--path', serverPath, '--pairing-code', 'remote-runtime', '--json'],
        '/tmp/repo'
      )

      expect(callMock).toHaveBeenCalledWith('repo.add', {
        path: serverPath
      })
    }
  )

  // Why: STA-4792 defect 2. `--host runtime:<id>` used to leave the client local, so a Windows
  // destination fell into resolve(cwd, ...) and became a literal directory next to the caller.
  // Routing makes the client remote, which is what sends the path through untouched.
  it('sends a windows destination to the routed host instead of joining it to the local cwd', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'awin')
    queueFixtures(
      callMock,
      okFixture('req_project_setup_clone', {
        result: {
          project: {
            id: 'github:mcode-ide/mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-awin',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'local',
            repoId: 'repo-awin',
            path: 'C:\\mcode-probe\\mcode',
            displayName: 'MCode',
            setupState: 'ready',
            setupMethod: 'cloned',
            createdAt: 1,
            updatedAt: 1
          },
          repo: {
            id: 'repo-awin',
            path: 'C:\\mcode-probe\\mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            addedAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-clone',
        '--project',
        'github:mcode-ide/mcode',
        '--host',
        'runtime:awin',
        '--url',
        'https://github.com/mcode-ide/mcode.git',
        '--destination',
        'C:\\mcode-probe',
        '--json'
      ],
      '/Users/nwparker/mcode/workspaces/mcode/IME-koko'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'awin')
    expect(callMock).toHaveBeenCalledWith(
      'projectHostSetup.clone',
      expect.objectContaining({ destination: 'C:\\mcode-probe' })
    )
  })

  it('updates project host setup metadata through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup_update', {
        result: {
          project: {
            id: 'github:mcode-ide/mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '/srv/mcode',
            displayName: 'GPU VM',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-update',
        '--setup',
        'setup-gpu',
        '--display-name',
        'GPU VM',
        '--path',
        '/srv/mcode',
        '--worktree-base-path',
        '../worktrees',
        '--state',
        'ready',
        '--method',
        'imported-existing-folder',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.update', {
      setupId: 'setup-gpu',
      updates: {
        displayName: 'GPU VM',
        path: path.resolve('/tmp/repo', '/srv/mcode'),
        worktreeBasePath: '../worktrees',
        gitUsername: undefined,
        kind: undefined,
        setupState: 'ready',
        setupMethod: 'imported-existing-folder'
      }
    })
  })

  it('creates independent project host setup metadata through the project-first runtime API', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'gpu')
    queueFixtures(
      callMock,
      okFixture('req_project_setup_create', {
        result: {
          project: {
            id: 'github:mcode-ide/mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '',
            displayName: 'GPU VM',
            setupState: 'setting-up',
            setupMethod: 'provisioned',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'project',
        'setup-create',
        '--project',
        'github:mcode-ide/mcode',
        '--host',
        'runtime:gpu',
        '--setup-id',
        'setup-gpu',
        '--display-name',
        'GPU VM',
        '--state',
        'setting-up',
        '--method',
        'provisioned',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.create', {
      projectId: 'github:mcode-ide/mcode',
      hostId: 'runtime:gpu',
      setupId: 'setup-gpu',
      path: undefined,
      kind: undefined,
      displayName: 'GPU VM',
      worktreeBasePath: undefined,
      gitUsername: undefined,
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })
  })

  it('deletes project host setup metadata through the project-first runtime API', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setup_delete', {
        result: {
          project: {
            id: 'github:mcode-ide/mcode',
            displayName: 'MCode',
            badgeColor: '#7c3aed',
            sourceRepoIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          setup: {
            id: 'setup-gpu',
            projectId: 'github:mcode-ide/mcode',
            hostId: 'runtime:gpu',
            repoId: '',
            path: '/srv/mcode',
            displayName: 'GPU VM',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'setup-delete', '--setup', 'setup-gpu', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('projectHostSetup.delete', {
      setupId: 'setup-gpu'
    })
  })
})
