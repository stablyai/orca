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
import { RuntimeRpcFailureError } from './runtime-client'
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

  it('passes an explicit parent through worktree.create without cwd inference', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          parentWorktreeId: 'repo-1::/tmp/repo/parent',
          lineage: {
            worktreeId: 'repo-1::/tmp/repo/child',
            worktreeInstanceId: 'child-instance',
            parentWorktreeId: 'repo-1::/tmp/repo/parent',
            parentWorktreeInstanceId: 'parent-instance',
            origin: 'cli',
            capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
            createdAt: 1
          }
        },
        lineage: {
          worktreeId: 'repo-1::/tmp/repo/child',
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: 'repo-1::/tmp/repo/parent',
          parentWorktreeInstanceId: 'parent-instance',
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        },
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
        'child',
        '--parent-worktree',
        'id:repo-1::/tmp/repo/parent',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: 'id:repo-1::/tmp/repo/parent',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('routes traditional parent-worktree selectors through parentWorktree', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          parentWorktreeId: 'repo-1::/tmp/repo/parent'
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
        'child',
        '--parent-worktree',
        'branch:feature/parent',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: 'branch:feature/parent',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('routes workspace-key parent-worktree selectors through parentWorkspace', async () => {
    const cases = [
      { selector: 'folder:folder-1', parentWorkspace: 'folder:folder-1' },
      {
        selector: 'worktree:repo-1::/tmp/repo/parent',
        parentWorkspace: 'worktree:repo-1::/tmp/repo/parent'
      },
      { selector: 'id:folder:folder-1', parentWorkspace: 'folder:folder-1' },
      {
        selector: 'id:worktree:repo-1::/tmp/repo/parent',
        parentWorkspace: 'worktree:repo-1::/tmp/repo/parent'
      }
    ]
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const testCase of cases) {
      callMock.mockReset()
      queueFixtures(
        callMock,
        okFixture('req_create', {
          worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          lineage: null,
          workspaceLineage: {
            childWorkspaceKey: 'worktree:repo-1::/tmp/repo/child',
            childInstanceId: 'child-instance',
            parentWorkspaceKey: testCase.parentWorkspace,
            parentInstanceId: null,
            origin: 'cli',
            capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
            createdAt: 1
          },
          warnings: []
        })
      )

      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'child',
          '--parent-worktree',
          testCase.selector,
          '--json'
        ],
        '/tmp/repo/parent/src'
      )

      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith('worktree.create', {
        repo: 'id:repo-1',
        name: 'child',
        baseBranch: undefined,
        linkedIssue: undefined,
        comment: undefined,
        runHooks: false,
        activate: false,
        parentWorktree: undefined,
        parentWorkspace: testCase.parentWorkspace,
        noParent: false,
        callerTerminalHandle: undefined,
        cliProvenanceRequest: {}
      })
    }
  })

  it('passes folder workspace environment lineage through worktree.create', async () => {
    process.env.ORCA_WORKSPACE_ID = 'folder:folder-1'
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        workspaceLineage: {
          childWorkspaceKey: 'worktree:repo-1::/tmp/repo/child',
          childInstanceId: 'child-instance',
          parentWorkspaceKey: 'folder:folder-1',
          parentInstanceId: null,
          origin: 'cli',
          capture: { source: 'env-workspace', confidence: 'inferred' },
          createdAt: 1
        },
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      envParentWorkspace: 'folder:folder-1',
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('resolves current for explicit parent-worktree on create', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/parent', 'feature/parent', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
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
        'child',
        '--parent-worktree',
        'current',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: 'id:repo-1::/tmp/repo/parent',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('routes active/current folder workspace parent selectors through parentWorkspace on create', async () => {
    const folderWorkspace = {
      ...buildWorktree('/tmp/folder', '', '', 'folder-workspace:group-1'),
      id: 'folder:folder-1',
      repoId: 'folder-workspace:group-1',
      displayName: 'Folder'
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const parentSelector of ['current', 'active']) {
      callMock.mockReset()
      queueFixtures(
        callMock,
        worktreeListFixture([folderWorkspace]),
        okFixture('req_create', {
          worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
          lineage: null,
          workspaceLineage: {
            childWorkspaceKey: 'worktree:repo-1::/tmp/repo/child',
            childInstanceId: 'child-instance',
            parentWorkspaceKey: 'folder:folder-1',
            parentInstanceId: null,
            origin: 'cli',
            capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
            createdAt: 1
          },
          warnings: []
        })
      )

      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'child',
          '--parent-worktree',
          parentSelector,
          '--json'
        ],
        '/tmp/folder/src'
      )

      expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
        repo: 'id:repo-1',
        name: 'child',
        baseBranch: undefined,
        linkedIssue: undefined,
        comment: undefined,
        runHooks: false,
        activate: false,
        parentWorktree: undefined,
        parentWorkspace: 'folder:folder-1',
        noParent: false,
        callerTerminalHandle: undefined,
        cliProvenanceRequest: {}
      })
    }
  })

  it('rejects contradictory parent flags on worktree.create before resolving selectors', async () => {
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
        'child',
        '--parent-worktree',
        'current',
        '--no-parent',
        '--json'
      ],
      '/tmp/not-managed'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either one parent selector or --no-parent.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects removed parent-workspace on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    const outputModes = [[], ['--json']]

    for (const outputArgs of outputModes) {
      logSpy.mockClear()
      errSpy.mockClear()
      process.exitCode = priorExitCode

      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'child',
          '--parent-workspace',
          'folder:folder-1',
          ...outputArgs
        ],
        '/tmp/repo'
      )

      const output = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
      expect(output).toContain('Unknown flag --parent-workspace for command: worktree create')
      expect(callMock).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
    }

    process.exitCode = priorExitCode
  })

  it('rejects bare parent-worktree on worktree.create', async () => {
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
        'child',
        '--parent-worktree',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing required --parent-worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('reports runtime parent selector failures without hidden flag guidance', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_create',
        ok: false,
        error: {
          code: 'LINEAGE_PARENT_NOT_FOUND',
          message: 'Parent selector was not found.',
          data: {
            nextSteps: [
              'Pass a valid --parent-worktree selector such as folder:<id>, worktree:<worktreeId>, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<absolute-path>, or active/current.',
              'Retry with --no-parent to create without lineage.'
            ]
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
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
        'child',
        '--parent-worktree',
        'folder:missing',
        '--json'
      ],
      '/tmp/repo'
    )

    const output = String(logSpy.mock.calls[0][0])
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      parentWorkspace: 'folder:missing',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
    expect(output).toContain('"ok": false')
    expect(output).toContain('Parent selector was not found.')
    expect(output).toContain('--parent-worktree selector')
    expect(output).not.toContain('--parent-workspace')
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes no-parent through worktree.create and skips cwd inference', async () => {
    queueFixtures(
      callMock,
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--no-parent', '--json'],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.create', {
      repo: 'id:repo-1',
      name: 'child',
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
})
