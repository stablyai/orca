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

vi.mock('./runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('./runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

vi.mock('./runtime/pairing/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn(async (_userDataPath: string, selector: string) => ({
    id: selector === 'desk' ? 'env-desk' : selector,
    name: selector
  }))
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { RuntimeRpcFailureError } from './runtime/connection/types'
import { okFixture } from './runtime/fixtures/runtime-rpc-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchFixture, agentLaunchHostFixture } from './agents/agent-launch-test-fixtures'

const ORIGINAL_EXIT_CODE = process.exitCode
const WORKSPACE_ID = 'vm-repo::/workspace/trees/fix-login'
const CREATED = {
  worktree: { id: WORKSPACE_ID, repoId: 'vm-repo', path: '/workspace/trees/fix-login' },
  host: {
    id: 'runtime:env-vm',
    environmentId: 'env-vm',
    runtimeId: 'vm-1',
    recipeId: 'fake-vm',
    checkoutMode: 'orca-worktree'
  }
}
const CREATE_ARGS = ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'fix-login']

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE
})

function recipeCreateCalls(): unknown[][] {
  return callMock.mock.calls.filter(([method]) => method === 'worktree.createOnRecipe')
}

async function run(argv: string[]) {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await main(argv, '/tmp/repo')
  return {
    stdout: logSpy.mock.calls.flat().join('\n'),
    stderr: [...errSpy.mock.calls.flat(), ...stderrSpy.mock.calls.map(([chunk]) => chunk)].join('')
  }
}

describe('orca worktree create --on recipe:<id>', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('asks the desktop to create it on the recipe, with progress on stderr and the result on stdout', async () => {
    callMock.mockImplementation(async (method: string, _params, options) => {
      expect(method).toBe('worktree.createOnRecipe')
      options?.onProgress?.({ phase: 'running-create' })
      options?.onProgress?.({ output: 'booting fake vm\n' })
      return okFixture('req_create', CREATED)
    })

    const { stdout, stderr } = await run([
      ...CREATE_ARGS,
      '--on',
      'recipe:fake-vm',
      '--base-branch',
      'origin/main',
      '--branch',
      'fix/login',
      '--setup',
      'skip',
      '--json'
    ])

    expect(process.exitCode).not.toBe(1)
    expect(recipeCreateCalls()).toEqual([
      [
        'worktree.createOnRecipe',
        expect.objectContaining({
          recipeId: 'fake-vm',
          repo: 'id:repo-1',
          name: 'fix-login',
          baseBranch: 'origin/main',
          branchNameOverride: 'fix/login',
          setupDecision: 'skip'
        }),
        expect.objectContaining({ onProgress: expect.any(Function) })
      ]
    ])
    expect(JSON.parse(stdout).result).toEqual(CREATED)
    expect(stderr).toContain('booting fake vm')
  })

  it('starts the agent on the new host once the workspace exists', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'worktree.createOnRecipe') {
        return okFixture('req_create', CREATED)
      }
      if (method === 'status.get') {
        return agentLaunchHostFixture()
      }
      return agentLaunchFixture(WORKSPACE_ID)
    })

    const { stdout } = await run([
      ...CREATE_ARGS,
      '--on',
      'recipe:fake-vm',
      '--agent',
      'codex',
      '--prompt',
      'Fix the login bug',
      '--json'
    ])

    expect(recipeCreateCalls()[0]?.[1]).toMatchObject({ createdWithAgent: 'codex' })
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'env-vm')
    const launch = callMock.mock.calls.find(([method]) => String(method).startsWith('agent.launch'))
    expect(launch?.[1]).toMatchObject({
      agent: 'codex',
      target: { kind: 'existing', worktree: `id:${WORKSPACE_ID}` },
      prompt: { text: 'Fix the login bug' }
    })
    const result = JSON.parse(stdout).result
    expect(result.host.runtimeId).toBe('vm-1')
    expect(result.launch).toMatchObject({ worktreeId: WORKSPACE_ID })
  })

  it.each([
    ['an existing host as the target', ['--on', 'ssh:box']],
    ['a malformed recipe id', ['--on', 'recipe:Not Valid']],
    ['activation', ['--on', 'recipe:fake-vm', '--activate']],
    ['a lost-launch retry', ['--on', 'recipe:fake-vm', '--agent', 'codex', '--retry-launch', 'x']],
    ['a paired server selection', ['--on', 'recipe:fake-vm', '--environment', 'desk']]
  ])('refuses %s before the desktop starts anything', async (_case, flags) => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-desk', 'desk')

    await run([...CREATE_ARGS, ...flags, '--json'])

    expect(process.exitCode).toBe(1)
    expect(recipeCreateCalls()).toEqual([])
  })

  it('reports a failed create with what became of the environment and how to recover', async () => {
    const missingTool = { id: 'tool.pnpm', category: 'tools', status: 'fail', message: 'missing' }
    callMock.mockRejectedValue(
      new RuntimeRpcFailureError({
        id: 'req_create',
        ok: false,
        error: {
          code: 'recipe_workspace_create_failed',
          message: 'The new environment failed its checks.',
          data: {
            phase: 'checking-environment',
            recipeId: 'fake-vm',
            runtimeId: 'vm-1',
            environment: 'destroy-failed',
            environmentChecks: [missingTool]
          }
        },
        _meta: { runtimeId: 'desktop' }
      })
    )

    const { stdout, stderr } = await run([...CREATE_ARGS, '--on', 'recipe:fake-vm', '--json'])

    expect(process.exitCode).toBe(1)
    const error = JSON.parse(stdout).error
    expect(error).toMatchObject({
      code: 'recipe_workspace_create_failed',
      data: { phase: 'checking-environment', runtimeId: 'vm-1', environment: 'destroy-failed' }
    })
    expect(error.data.nextSteps).toHaveLength(2)
    expect(stderr).toContain('tool.pnpm')
  })
})
