import { describe, expect, it, vi } from 'vitest'
import { AUTOMATION_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../shared/protocol-version'

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

describe('orca cli automation launch preferences', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('passes model and effort through create and can restore defaults on edit', async () => {
    const status = okFixture('status', {
      capabilities: [AUTOMATION_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY]
    })
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo', 'abc', 'repo-1')]),
      status,
      okFixture('create', { automation: { id: 'auto-1', name: 'Daily review' } }),
      status,
      okFixture('edit', { automation: { id: 'auto-1', name: 'Daily review' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Daily review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'codex',
        '--model',
        'gpt-5.6-sol',
        '--effort',
        'high',
        '--workspace',
        'current',
        '--json'
      ],
      '/tmp/repo/feature/src'
    )
    await main(['automations', 'edit', 'auto-1', '--default-model', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'automation.create',
      expect.objectContaining({
        launchPreferences: { model: 'gpt-5.6-sol', effort: 'high' }
      })
    )
    expect(callMock).toHaveBeenNthCalledWith(5, 'automation.update', {
      id: 'auto-1',
      updates: expect.objectContaining({ launchPreferences: null })
    })
  })

  it('rejects effort without a model before calling the runtime', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['automations', 'edit', 'auto-1', '--effort', 'high', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
