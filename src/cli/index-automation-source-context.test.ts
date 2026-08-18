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
import { okFixture, queueFixtures } from './test-fixtures'
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

  it('passes automation source context JSON through create', async () => {
    const sourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu',
      projectHostSetupId: 'setup-gpu',
      repoId: 'repo-gpu',
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
      accountLabel: 'gpu-bot'
    }
    queueFixtures(
      callMock,
      okFixture('req_automation_create', {
        automation: { id: 'auto-1', name: 'GPU task review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'GPU task review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open work',
        '--provider',
        'codex',
        '--repo',
        'id:repo-gpu',
        '--source-context',
        JSON.stringify(sourceContext),
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      1,
      'automation.create',
      expect.objectContaining({
        repo: 'id:repo-gpu',
        sourceContext
      })
    )
  })

  it('clears automation source context on edit with null', async () => {
    queueFixtures(
      callMock,
      okFixture('req_edit', {
        automation: { id: 'auto-1', name: 'GPU task review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--source-context', 'null', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      1,
      'automation.update',
      expect.objectContaining({
        id: 'auto-1',
        updates: expect.objectContaining({
          sourceContext: null
        })
      })
    )
  })

  it('rejects invalid automation source context JSON before calling the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'GPU task review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open work',
        '--provider',
        'codex',
        '--repo',
        'id:repo-gpu',
        '--source-context',
        '{nope',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--source-context must be valid JSON'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
