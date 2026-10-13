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

import { agentLaunchFixture, agentLaunchHostFixture } from './agent-launch-test-fixtures'
import { WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY } from '../shared/worktree-recipe-create-capability'

describe('CLI worktree create --recipe', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })
  const command = [
    'worktree',
    'create',
    '--repo',
    'id:source',
    '--name',
    'task',
    '--recipe',
    'sandbox',
    '--no-parent',
    '--json'
  ]
  const sourceStatus = () =>
    okFixture('source', { capabilities: [WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY] })
  const created = () =>
    okFixture('create', {
      worktree: buildWorktree('/checkout', 'task', 'head', 'remote'),
      recipeEnvironmentId: 'env-vm'
    })

  it('selects the recipe only after verifying the provisioning host supports it', async () => {
    queueFixtures(callMock, sourceStatus(), created())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(command, '/outside')
    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.create',
      expect.objectContaining({ repo: 'id:source', recipeId: 'sandbox' }),
      { timeoutMs: 600_000 }
    )
    expect(log.mock.calls.flat().join('')).toContain('recipeEnvironmentId')
  })
  it('refuses an older host before creating a local checkout', async () => {
    queueFixtures(callMock, okFixture('old', { capabilities: [] }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(command, '/outside')
    expect(process.exitCode).toBe(1)
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
  })
  it.each([{ recipe: ['--recipe'] }, { recipe: ['--recipe', ''] }])(
    'rejects a missing recipe value: %j',
    async ({ recipe }) => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:source',
          '--name',
          'task',
          '--no-parent',
          ...recipe,
          '--json'
        ],
        '/outside'
      )
      expect(process.exitCode).toBe(1)
      expect(callMock).not.toHaveBeenCalled()
    }
  )
  it('launches the agent on the new environment using the adopted workspace', async () => {
    queueFixtures(
      callMock,
      sourceStatus(),
      created(),
      agentLaunchHostFixture(),
      agentLaunchFixture('remote::/checkout')
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        ...command,
        '--agent',
        'codex',
        '--model',
        'gpt-6-astra',
        '--effort',
        'high',
        '--prompt',
        'Work here'
      ],
      '/outside'
    )
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'id:env-vm')
    const launch = callMock.mock.calls.find(
      ([method]) => method === 'agent.launch' || method === 'agent.launchReplay'
    )
    expect(launch?.[1]).toMatchObject({
      agent: 'codex',
      target: { kind: 'existing', worktree: 'id:remote::/checkout' },
      prompt: { text: 'Work here' }
    })
  })
})
