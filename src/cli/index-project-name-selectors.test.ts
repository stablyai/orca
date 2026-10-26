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
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const ORCA_PROJECT = {
  id: 'github:stablyai/orca',
  displayName: 'Orca',
  badgeColor: '#7c3aed',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}
const PROJECT_LIST_FIXTURE = okFixture('req_project_list', { projects: [ORCA_PROJECT] })

describe('orca cli project and host names', () => {
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

  it('filters project setups by the display name and host name the list commands print', async () => {
    queueFixtures(
      callMock,
      okFixture('req_ssh_targets', {
        targets: [{ id: 'ssh-1789189705224-tq82n1', label: 'simnode-local' }]
      }),
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-simnode',
            projectId: 'github:younghwan91/scalp-it',
            hostId: 'ssh:ssh-1789189705224-tq82n1',
            repoId: 'repo-simnode',
            path: '/home/young/git/scalp-it',
            displayName: 'scalp-it',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-other',
            projectId: 'github:stablyai/orca',
            hostId: 'ssh:ssh-1789189705224-tq82n1',
            repoId: 'repo-other',
            path: '/home/young/git/orca',
            displayName: 'orca',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_project_list', {
        projects: [
          { ...ORCA_PROJECT, id: 'github:younghwan91/scalp-it', displayName: 'Scalp It' },
          ORCA_PROJECT
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'setups', '--project', 'scalp it', '--host', 'simnode-local'],
      '/tmp/repo'
    )

    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('setup-simnode')
    expect(printed).not.toContain('setup-other')
  })

  it('refuses a project display name two projects share instead of guessing', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', { setups: [] }),
      okFixture('req_project_list', {
        projects: [ORCA_PROJECT, { ...ORCA_PROJECT, id: 'repo:second-orca' }]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['project', 'setups', '--project', 'orca', '--json'], '/tmp/repo')

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('Ambiguous --project orca'),
        data: {
          nextSteps: expect.arrayContaining([expect.stringContaining('--project repo:second-orca')])
        }
      }
    })
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('sends the project id when a setup command names the project by display name', async () => {
    queueFixtures(
      callMock,
      okFixture('req_ssh_targets', { targets: [] }),
      PROJECT_LIST_FIXTURE,
      okFixture('req_project_setup_create', { result: {} })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['project', 'setup-create', '--project', 'Orca', '--host', 'this machine', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'projectHostSetup.create',
      expect.objectContaining({ projectId: 'github:stablyai/orca', hostId: 'local' })
    )
  })

  it('keeps an exact project id even when another project is named that id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_project_setups', {
        setups: [
          {
            id: 'setup-pending',
            projectId: 'repo:alpha',
            hostId: 'local',
            repoId: 'repo-alpha',
            path: '/tmp/alpha',
            displayName: 'alpha',
            setupState: 'setting-up',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'setup-impostor',
            projectId: 'repo:beta',
            hostId: 'local',
            repoId: 'repo-beta',
            path: '/tmp/beta',
            displayName: 'repo:alpha',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      okFixture('req_project_list', {
        projects: [
          { ...ORCA_PROJECT, id: 'repo:alpha', displayName: 'alpha' },
          { ...ORCA_PROJECT, id: 'repo:beta', displayName: 'repo:alpha' }
        ]
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--project', 'repo:alpha', '--name', 'x', '--no-parent', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('No ready setup found for --project repo:alpha')
      }
    })
    expect(errSpy).not.toHaveBeenCalled()
  })
})
