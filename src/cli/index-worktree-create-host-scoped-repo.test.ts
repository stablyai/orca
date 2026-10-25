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
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const SSH_CALLER = {
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'box-b',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'inc-1',
  ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'att-1'
}

describe('worktree create from a worktree another host shares an id with', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  afterEach(() => {
    for (const key of Object.keys(SSH_CALLER)) {
      delete process.env[key]
    }
  })

  it('infers the repo while the parent stays the exact host-scoped identity', async () => {
    Object.assign(process.env, SSH_CALLER)
    queueFixtures(
      callMock,
      worktreeListFixture([
        {
          ...buildWorktree('/srv/app', 'main', 'abc', 'repo-1'),
          hostId: 'ssh:box-a',
          identity: { key: 'wt2:a' }
        },
        {
          ...buildWorktree('/srv/app', 'main', 'abc', 'repo-1'),
          hostId: 'ssh:box-b',
          identity: { key: 'wt2:b' }
        }
      ]),
      okFixture('req_create', {
        worktree: buildWorktree('/srv/app-child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'create', '--name', 'child', '--json'], '/srv/app/src')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-1', cwdParentWorktree: 'identity:wt2:b' })
    )
  })
})
