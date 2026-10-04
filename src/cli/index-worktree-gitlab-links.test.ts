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
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const ISSUE_URL = 'https://gitlab.example.com:8443/group/sub/project/-/work_items/53'

describe('GitLab flag project identity', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each([
    { source: 'https://gitlab.example.com:8443/group/sub/project', allowed: true },
    { source: 'https://gitlab.example.com:8443/group/foreign', allowed: false },
    { source: 'https://gitlab.example.com:8080/group/sub/project', allowed: false }
  ])('checks the stored source project $source on set', async ({ source, allowed }) => {
    queueFixtures(
      callMock,
      okFixture('req_source', {
        worktree: {
          ...buildWorktree('/tmp/repo/child', 'linked-task'),
          linkedTaskSourceContext: {
            kind: 'task-source',
            provider: 'gitlab',
            projectId: 'project',
            hostId: 'local',
            providerIdentity: { provider: 'gitlab', webUrl: source }
          }
        }
      }),
      okFixture('req_set', { worktree: buildWorktree('/tmp/repo/child', 'linked-task') })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'worktree',
        'set',
        '--worktree',
        'id:repo::/tmp/repo/child',
        '--gitlab-issue',
        ISSUE_URL,
        '--json'
      ],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.show', {
      worktree: 'id:repo::/tmp/repo/child'
    })
    if (allowed) {
      expect(callMock).toHaveBeenNthCalledWith(
        2,
        'worktree.set',
        expect.objectContaining({ linkedGitLabIssue: 53 })
      )
      expect(callMock.mock.calls[1][1]).not.toHaveProperty('linkedWorkItem')
      expect(callMock.mock.calls[1][1]).not.toHaveProperty('linkedTaskSourceContext')
    } else {
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls.flat().join('\n')).toContain(
        'must match the workspace source project'
      )
      expect(process.exitCode).toBe(1)
    }
  })

  for (const command of ['create', 'set'] as const) {
    it.each([
      { remote: 'ssh://git@gitlab.example.com:2222/group/sub/project.git', allowed: false },
      { remote: 'https://gitlab.example.com:8443/group/sub/project.git', allowed: true },
      { remote: 'https://gitlab.example.com:8443/group/foreign.git', allowed: false },
      { remote: undefined, allowed: false }
    ])(`${command} checks the stored remote $remote`, async ({ remote, allowed }) => {
      if (command === 'set') {
        queueFixtures(
          callMock,
          okFixture('req_show', { worktree: buildWorktree('/tmp/repo/child', 'linked-task') })
        )
      }
      queueFixtures(
        callMock,
        okFixture('req_repo', {
          repo: {
            id: 'repo',
            kind: remote ? 'git' : 'folder',
            ...(remote
              ? {
                  gitRemoteIdentity: {
                    remoteUrl: remote,
                    canonicalKey: 'unused',
                    remoteName: 'origin'
                  }
                }
              : {})
          }
        }),
        okFixture('req_write', {
          worktree: buildWorktree('/tmp/repo/child', 'linked-task'),
          lineage: null,
          warnings: []
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const target =
        command === 'create'
          ? ['--repo', 'id:repo', '--name', 'linked-task', '--no-parent']
          : ['--worktree', 'id:repo::/tmp/repo/child']
      await main(
        ['worktree', command, ...target, '--gitlab-issue', ISSUE_URL, '--json'],
        '/tmp/repo'
      )
      const readCount = command === 'create' ? 1 : 2
      expect(callMock).toHaveBeenNthCalledWith(readCount, 'repo.show', { repo: 'id:repo' })
      if (allowed) {
        expect(callMock).toHaveBeenNthCalledWith(
          readCount + 1,
          `worktree.${command}`,
          expect.objectContaining({ linkedGitLabIssue: 53 })
        )
      } else {
        expect(callMock).toHaveBeenCalledTimes(readCount)
        expect(process.exitCode).toBe(1)
      }
    })
  }

  it('accepts an scp remote without guessing a web port', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo', {
        repo: { id: 'repo', gitRemoteIdentity: { remoteUrl: 'git@gitlab.com:group/project.git' } }
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/child', 'linked-task'),
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
        'id:repo',
        '--name',
        'linked-task',
        '--no-parent',
        '--gitlab-mr',
        'https://gitlab.com/group/project/-/merge_requests/77/diffs',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.create',
      expect.objectContaining({ linkedGitLabMR: 77 })
    )
  })
})
