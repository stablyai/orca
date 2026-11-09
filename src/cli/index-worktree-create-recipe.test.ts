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
import { WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY } from '../shared/host-runtime-capabilities'

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
      recipe: {
        id: 'sandbox',
        runtimeId: 'vm',
        environmentId: 'env-vm',
        checkoutMode: 'orca-worktree'
      }
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
      expect.objectContaining({ timeoutMs: 600_000, onProgress: expect.any(Function) })
    )
    expect(log.mock.calls.flat().join('')).toContain('"environmentId": "env-vm"')
  })
  it('prints named progress steps to stderr without touching stdout', async () => {
    callMock.mockImplementationOnce(async () => sourceStatus())
    callMock.mockImplementationOnce(
      async (
        _method: string,
        _params: unknown,
        options?: { onProgress?: (p: unknown) => void }
      ) => {
        options?.onProgress?.({ phase: 'running-create' })
        options?.onProgress?.({ phase: 'not-a-known-phase' })
        return created()
      }
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(
      command.filter((arg) => arg !== '--json'),
      '/outside'
    )
    const stderr = error.mock.calls.flat().join('\n')
    expect(stderr).toContain('from recipe "sandbox"')
    expect(stderr).toContain("- Running the recipe's create step...")
    expect(stderr).not.toContain('not-a-known-phase')
    expect(log.mock.calls.flat().join('')).toContain('environment: env-vm')
  })
  it('adds next steps to a failed create and keeps the failure data', async () => {
    callMock.mockImplementationOnce(async () => sourceStatus())
    callMock.mockImplementationOnce(async () => {
      const { RuntimeClientError } = await import('./runtime-client.js')
      throw new RuntimeClientError(
        'recipe_workspace_create_failed',
        'Boom. Orca destroyed the new environment.',
        {
          phase: 'checking-host',
          environment: 'destroyed'
        }
      )
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(command, '/outside')
    expect(process.exitCode).toBe(1)
    const output = log.mock.calls.flat().join('')
    expect(output).toContain('recipe_workspace_create_failed')
    expect(output).toContain('checking-host')
    expect(output).toContain('orca vm recipe doctor sandbox')
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

describe('CLI vm recipe list', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })
  const listing = {
    repos: [
      {
        repoId: 'source',
        repoName: 'orca',
        repoPath: '/src/orca',
        recipes: [
          {
            id: 'sandbox',
            name: 'Sandbox',
            checkoutMode: 'orca-worktree',
            steps: ['destroy'],
            destroyDisabled: false,
            timeoutSeconds: { create: 600 }
          }
        ],
        diagnostics: [{ index: 1, field: 'create', message: 'Missing create command.' }]
      }
    ]
  }

  it('lists one repo after checking the host can run recipes', async () => {
    queueFixtures(
      callMock,
      okFixture('host', { capabilities: [WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY] }),
      okFixture('list', listing)
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['vm', 'recipe', 'list', '--repo', 'id:source'], '/outside')
    expect(callMock).toHaveBeenNthCalledWith(2, 'vmRecipe.list', { repo: 'id:source' })
    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain(
      'sandbox  Sandbox  [orca-worktree; destroys on removal; timeouts create 600s]'
    )
    expect(output).toContain('warning: environmentRecipes[1].create: Missing create command.')
  })

  it('refuses a host that cannot run recipes without calling the list method', async () => {
    queueFixtures(callMock, okFixture('old', { capabilities: [] }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(['vm', 'recipe', 'list', '--json'], '/outside')
    expect(process.exitCode).toBe(1)
    expect(callMock.mock.calls.some(([method]) => method === 'vmRecipe.list')).toBe(false)
  })
})

describe('CLI worktree create --recipe refusals', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('refuses --activate before asking the host anything', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:source',
        '--name',
        'task',
        '--recipe',
        'sandbox',
        '--no-parent',
        '--activate',
        '--json'
      ],
      '/outside'
    )
    expect(process.exitCode).toBe(1)
    expect(log.mock.calls.flat().join('')).toContain('--activate is not supported with --recipe')
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
  })
})
