import { afterEach, describe, expect, it, vi } from 'vitest'

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
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

function group(id: string, name: string) {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function printedJson(logSpy: ReturnType<typeof vi.spyOn>): unknown {
  return JSON.parse(String(logSpy.mock.calls[0]?.[0]))
}

describe('orca project group', () => {
  const priorExitCode = process.exitCode
  afterEach(() => {
    process.exitCode = priorExitCode
  })
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('lists each group with its projects in sidebar order', async () => {
    queueFixtures(
      callMock,
      okFixture('req_groups', { groups: [group('group-archive', 'Archive')] }),
      okFixture('req_repos', {
        repos: [
          {
            id: 'repo-late',
            displayName: 'late',
            projectGroupId: 'group-archive',
            projectGroupOrder: 2
          },
          { id: 'repo-loose', displayName: 'loose', projectGroupId: null },
          {
            id: 'repo-early',
            displayName: 'early',
            projectGroupId: 'group-archive',
            projectGroupOrder: 1
          }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'group', 'list', '--json'], '/tmp/repo')

    expect(printedJson(logSpy)).toMatchObject({
      result: {
        groups: [
          {
            id: 'group-archive',
            repos: [
              { id: 'repo-early', displayName: 'early' },
              { id: 'repo-late', displayName: 'late' }
            ]
          }
        ]
      }
    })
  })

  it('moves a project into a group named by name, pinned to its SSH twin', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-remote',
            projectId: 'github:stablyai/orca',
            hostId: 'ssh:target-1',
            repoId: 'repo-1',
            path: '/home/me/orca',
            displayName: 'orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_groups', { groups: [group('group-archive', 'Archive')] }),
      okFixture('req_move', { repo: { id: 'repo-1', projectGroupId: 'group-archive' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'group', 'add', '--group', 'archive', '--project', 'github:stablyai/orca'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('projectGroup.moveProject', {
      repo: 'id:repo-1',
      connectionId: 'target-1',
      groupId: 'group-archive'
    })
  })

  it('ungroups a repo selector without guessing its host', async () => {
    queueFixtures(callMock, okFixture('req_move', { repo: { id: 'repo-1', projectGroupId: null } }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'group', 'ungroup', '--repo', 'id:repo-1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('projectGroup.moveProject', {
      repo: 'id:repo-1',
      groupId: null
    })
  })

  it('refuses an unknown group instead of letting the move ungroup the project', async () => {
    queueFixtures(
      callMock,
      okFixture('req_groups', { groups: [group('group-archive', 'Archive')] })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'group', 'add', '--group', 'Archvie', '--repo', 'id:repo-1', '--json'],
      '/tmp/repo'
    )

    expect(printedJson(logSpy)).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Project group not found: Archvie' }
    })
    expect(callMock).not.toHaveBeenCalledWith('projectGroup.moveProject', expect.anything())
    expect(process.exitCode).toBe(1)
  })

  it('refuses a group name two groups share', async () => {
    queueFixtures(
      callMock,
      okFixture('req_groups', {
        groups: [group('group-a', 'Archive'), group('group-b', 'archive')]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['project', 'group', 'rm', '--group', 'Archive', '--json'], '/tmp/repo')

    expect(printedJson(logSpy)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Ambiguous --group Archive: 2 project groups are named that. Use the group id.'
      }
    })
    expect(callMock).not.toHaveBeenCalledWith('projectGroup.delete', expect.anything())
  })
})
