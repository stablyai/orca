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
import { RuntimeRpcFailureError } from './runtime/types'
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

  it('identifies unsupported folder parents and avoids blaming the child for missing parents', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    const child = 'id:repo::/tmp/repo/child'
    try {
      for (const parent of ['folder:folder-1', 'id:folder:folder-1']) {
        logSpy.mockClear()
        await main(
          ['worktree', 'set', '--worktree', child, '--parent-worktree', parent, '--json'],
          '/tmp/repo'
        )
        expect(callMock).not.toHaveBeenCalled()
        const output = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}').error
        expect(output.message).toContain(`Parent selector "${parent}" is a folder.`)
        expect(output.message).toContain(
          'Folder parents are accepted only by orca worktree create.'
        )
        expect(process.exitCode).toBe(1)
      }

      callMock.mockRejectedValueOnce(
        new RuntimeRpcFailureError({
          id: 'req_missing_parent',
          ok: false,
          error: {
            code: 'selector_not_found',
            message: 'selector_not_found',
            data: { orchestrationRequestId: 'req_mutation', nextSteps: ['Inspect mutation.'] }
          }
        })
      )
      logSpy.mockClear()
      await main(
        ['worktree', 'set', '--worktree', child, '--parent-worktree', 'name:missing', '--json'],
        '/tmp/repo'
      )
      const output = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}').error
      expect(callMock.mock.calls.map(([method]) => method)).toEqual(['worktree.set'])
      expect(output.data.orchestrationRequestId).toBe('req_mutation')
      expect(output.data.nextSteps).toContain('Inspect mutation.')
      expect(output.data.nextSteps.join(' ')).toContain('parent selector "name:missing"')
      expect(output.data.nextSteps.join(' ')).toContain(
        'The server did not identify which selector failed.'
      )
      expect(output.data.nextSteps.join(' ')).not.toContain(
        'No Orca workspace matched the worktree selector'
      )
      expect(process.exitCode).toBe(1)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('keeps child and parent lookup recovery distinct before mutation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    const cwd = '/tmp/not-managed'
    const rpc = {
      id: 'req_child',
      ok: false as const,
      error: {
        code: 'selector_not_found',
        message: 'selector_not_found',
        data: { orchestrationRequestId: 'req_original', nextSteps: ['Inspect original request.'] }
      },
      _meta: { runtimeId: 'runtime_original' }
    }
    try {
      for (const stage of ['child', 'parent', 'preflight']) {
        for (const json of [true, false]) {
          callMock.mockReset()
          log.mockClear()
          err.mockClear()
          const worktree = stage === 'child' ? 'current' : 'name:x'
          const parent = stage === 'parent' ? 'current' : 'name:existing-parent'
          if (stage === 'preflight') {
            callMock.mockRejectedValueOnce(new RuntimeRpcFailureError(rpc))
          } else {
            queueFixtures(callMock, worktreeListFixture([]))
          }
          const args = ['worktree', 'set', '--worktree', worktree, '--parent-worktree', parent]
          if (stage === 'preflight') {
            args.push('--gitlab-issue', 'https://gitlab.com/group/repo/-/issues/1')
          }
          await main([...args, ...(json ? ['--json'] : [])], cwd)
          const text = String((json ? log : err).mock.calls.at(-1)?.[0])
          const response = json ? JSON.parse(text) : undefined
          expect(callMock.mock.calls.map(([method]) => method)).toEqual([
            stage === 'preflight' ? 'worktree.show' : 'worktree.list'
          ])
          expect(text).toContain(
            stage === 'preflight' ? 'Inspect original request.' : `current directory: ${cwd}`
          )
          expect(text).toContain(
            stage === 'parent' ? 'explicit parent selector' : 'No Orca workspace matched'
          )
          expect(text).not.toContain(stage === 'parent' ? 'name:x' : 'parent selector')
          if (response) {
            expect(response.id).toBe(stage === 'preflight' ? rpc.id : 'local')
            expect(response._meta.runtimeId).toBe(
              stage === 'preflight' ? rpc._meta.runtimeId : null
            )
            if (stage === 'preflight') {
              expect(response.error.data).toMatchObject({ orchestrationRequestId: 'req_original' })
            }
          }
        }
      }
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('uses cwd when active is passed to worktree.set', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([
        buildWorktree('/tmp/repo', 'main', 'aaa'),
        buildWorktree('/tmp/repo/feature', 'feature/foo')
      ]),
      okFixture('req_1', {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature',
          comment: 'hello'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'active', '--comment', 'hello', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.set', {
      worktree: 'id:repo::/tmp/repo/feature',
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'hello',
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('passes parent lineage through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: 'repo::/tmp/repo/parent',
          childWorktreeIds: [],
          lineage: {
            worktreeId: 'repo::/tmp/repo/child',
            worktreeInstanceId: 'child-instance',
            parentWorktreeId: 'repo::/tmp/repo/parent',
            parentWorktreeInstanceId: 'parent-instance',
            origin: 'manual',
            capture: { source: 'manual-action', confidence: 'explicit' },
            createdAt: 1
          }
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--parent-worktree',
        'id:repo::/tmp/repo/parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      parentWorktree: 'id:repo::/tmp/repo/parent',
      noParent: false
    })
  })

  it('resolves current for explicit parent-worktree on set', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/parent', 'feature/parent')]),
      okFixture('req_set_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: 'repo::/tmp/repo/parent',
          childWorktreeIds: [],
          lineage: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--parent-worktree',
        'current',
        '--json'
      ],
      '/tmp/repo/parent/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      parentWorktree: 'id:repo::/tmp/repo/parent',
      noParent: false
    })
  })

  it('rejects contradictory parent flags on worktree.set before resolving selectors', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--parent-worktree',
        'current',
        '--no-parent',
        '--json'
      ],
      '/tmp/not-managed'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either --parent-worktree or --no-parent, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects bare parent-worktree on worktree.set', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--parent-worktree', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing required --parent-worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('passes parent removal through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_clear_parent', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--no-parent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: true
    })
  })

  it('passes Linear URL metadata through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_linear', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
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
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--linear-issue',
        'https://linear.app/stably/issue/STA-335/test-issue',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: 'stably',
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('clears all Linear metadata through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_clear_linear', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          linkedLinearIssue: null,
          linkedLinearIssueWorkspaceId: null,
          linkedLinearIssueOrganizationUrlKey: null
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--linear-issue',
        'null',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null,
      comment: undefined,
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('rejects invalid Linear issue values on worktree.set before RPC', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--linear-issue',
        'not-a-linear-link',
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

  it('passes workspace status through worktree.set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_status', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'feature/child'),
          workspaceStatus: 'in-review'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--workspace-status',
        'in-review',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      workspaceStatus: 'in-review',
      parentWorktree: undefined,
      noParent: false
    })
  })

  it.each([
    ['id:repo::/tmp/repo/child', '--unread', true],
    ['id:repo::/tmp/repo/child', '--read', false],
    ['id:folder:folder-1', '--unread', true],
    ['id:folder:folder-1', '--read', false]
  ])('passes %s %s through worktree.set as isUnread', async (selector, flag, isUnread) => {
    queueFixtures(
      callMock,
      okFixture('req_set_unread', {
        worktree: { id: selector.slice('id:'.length), isUnread }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'set', '--worktree', selector, flag, '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledExactlyOnceWith('worktree.set', {
      worktree: selector,
      displayName: undefined,
      linkedIssue: undefined,
      comment: undefined,
      workspaceStatus: undefined,
      isUnread,
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('leaves isUnread unchanged when neither --unread nor --read is passed', async () => {
    queueFixtures(
      callMock,
      okFixture('req_set_comment', { worktree: buildWorktree('/tmp/repo/child', 'feature/child') })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'id:repo::/tmp/repo/child', '--comment', 'hi', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'worktree.set',
      expect.objectContaining({
        worktree: 'id:repo::/tmp/repo/child',
        comment: 'hi',
        isUnread: undefined
      })
    )
  })

  it.each([
    [['--unread', '--read'], 'Choose either --unread or --read'],
    [['--read', '--unread'], 'Choose either --unread or --read'],
    [['--read', 'yes'], '--read takes no value'],
    [['--read=false'], '--read takes no value'],
    [['--read='], '--read takes no value'],
    [['--unread=false'], '--unread takes no value'],
    [['--unread='], '--unread takes no value']
  ])('rejects %j on worktree.set before resolving selectors', async (flags, message) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    // Resolving active makes an RPC, so no calls proves validation ran first.
    await main(['worktree', 'set', '--worktree', 'active', ...flags, '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(message)
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
