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
import {
  buildWorktree,
  okFixture,
  queueFixtures,
  workspaceDestinationFixtures,
  worktreeListFixture
} from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli automation launch preferences', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('pins a model and effort on create and unpins the model on edit', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      ...workspaceDestinationFixtures(),
      okFixture('req_create', { automation: { id: 'auto-1', name: 'Nightly triage' } }),
      okFixture('req_edit_owner', { automation: { id: 'auto-1', name: 'Nightly triage' } }),
      okFixture('req_edit', { automation: { id: 'auto-1', name: 'Nightly triage' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Nightly triage',
        '--trigger',
        'daily',
        '--prompt',
        'Triage the backlog',
        '--provider',
        'claude',
        '--model',
        'opus',
        '--effort',
        'high',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )
    await main(['automations', 'edit', 'auto-1', '--model', 'null', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      4,
      'automation.create',
      expect.objectContaining({ model: 'opus', effort: 'high' })
    )
    expect(callMock).toHaveBeenNthCalledWith(5, 'automation.show', { id: 'auto-1' })
    expect(callMock).toHaveBeenNthCalledWith(6, 'automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ model: null })
    })
  })
})
