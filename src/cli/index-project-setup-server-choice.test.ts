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
import { PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY } from '../shared/worktree-runtime-capabilities'

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

describe("an explicit --server picks that server's own project setup", () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it("uses the named server's own setup when --server is explicit", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
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
        '--server',
        'local',
        '--name',
        'feature',
        '--no-parent',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-local', repoHostId: 'local' })
    )
  })

  it("updates the named server's own twin when a setup id repeats across servers", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    queueFixtures(
      callMock,
      okFixture('req_setups', {
        setups: [
          buildSetup({ id: 'repo-1', hostId: 'ssh:box', repoId: 'repo-1' }),
          buildSetup({ id: 'repo-1', hostId: 'local', repoId: 'repo-1' })
        ]
      }),
      okFixture('req_status', {
        capabilities: [PROJECT_HOST_SETUP_HOST_TARGET_RUNTIME_CAPABILITY]
      }),
      okFixture('req_update', {
        result: { setup: buildSetup({ id: 'repo-1', hostId: 'local', repoId: 'repo-1' }) }
      })
    )

    await main(
      [
        'project',
        'setup-update',
        '--setup',
        'repo-1',
        '--server',
        'local',
        '--display-name',
        'A',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'projectHostSetup.update',
      expect.objectContaining({ setupId: 'repo-1', hostId: 'local' })
    )
  })
})
