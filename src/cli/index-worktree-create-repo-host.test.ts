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

function buildSetup(overrides: { id: string; hostId: string; repoId: string; path: string }) {
  return {
    projectId: 'github:stablyai/orca',
    displayName: 'Orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

// Copies on different hosts retain the same repo id.
const TWIN_SETUPS = [
  buildSetup({ id: 'setup-1', hostId: 'local', repoId: 'repo-1', path: '/tmp/orca' }),
  buildSetup({ id: 'setup-1', hostId: 'runtime:gpu', repoId: 'repo-1', path: '/srv/orca' })
]

describe('orca worktree create carries the selected host', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  function queueCreate(): void {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', { setups: TWIN_SETUPS }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/orca/feature', 'feature', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
  }

  it('sends the host --project --host chose, not just the repo id', async () => {
    queueCreate()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--project',
        'github:stablyai/orca',
        '--host',
        'local',
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
      expect.objectContaining({ repo: 'id:repo-1', repoHostId: 'local' })
    )
  })

  it('applies --host to a --project-host-setup id that repeats across hosts', async () => {
    queueCreate()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--project-host-setup',
        'setup-1',
        '--host',
        'local',
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
      expect.objectContaining({ repo: 'id:repo-1', repoHostId: 'local' })
    )
  })

  it('asks for --host when a repeated --project-host-setup id names two hosts', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    queueCreate()

    await main(
      [
        'worktree',
        'create',
        '--project-host-setup',
        'setup-1',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('Ambiguous --project-host-setup setup-1')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('checks a GitLab link against the repo on the selected host', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', { setups: TWIN_SETUPS }),
      okFixture('req_repo', {
        repo: { id: 'repo-1', gitRemoteIdentity: { remoteUrl: 'https://gitlab.com/acme/app.git' } }
      }),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/orca/feature', 'feature', 'abc', 'repo-1'),
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
        'local',
        '--gitlab-mr',
        'https://gitlab.com/acme/app/-/merge_requests/5',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'repo.show', {
      repo: 'id:repo-1',
      repoHostId: 'local'
    })
    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-1', repoHostId: 'local' })
    )
  })

  it('names the host when a --project-host-setup id is missing there', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    queueFixtures(callMock, okFixture('req_project_setups', { setups: [TWIN_SETUPS[1]] }))

    await main(
      [
        'worktree',
        'create',
        '--project-host-setup',
        'setup-1',
        '--host',
        'local',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(printed).toContain('not ready or was not found: setup-1 on local')
    process.exitCode = priorExitCode
  })

  it('keeps --repo selector-only', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'create', '--repo', 'id:repo-1', '--name', 'f', '--json'], '/tmp/repo')

    expect(callMock.mock.calls[1]?.[1]).not.toHaveProperty('repoHostId')
  })
})
