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
import { buildWorktree, okFixture, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { WORKTREE_CREATE_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../shared/protocol-version'

function answerByMethod(capabilities: string[]): void {
  callMock.mockImplementation(async (method: string) => {
    if (method === 'status.get') {
      return okFixture('req_status', { capabilities })
    }
    if (method === 'worktree.create') {
      return okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    }
    return worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')])
  })
}

function createCall(): Record<string, unknown> | undefined {
  return callMock.mock.calls.find(([method]) => method === 'worktree.create')?.[1]
}

const CREATE_ARGV = ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'agent-task']

describe('orca worktree create --model/--effort', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('sends the per-launch model and effort with the startup agent', async () => {
    answerByMethod([WORKTREE_CREATE_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        ...CREATE_ARGV,
        '--agent',
        'codex',
        '--model',
        'gpt-5.6-sol',
        '--effort',
        'high',
        '--prompt',
        'hi',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(createCall()).toMatchObject({
      startupAgent: 'codex',
      startupPrompt: 'hi',
      launchSource: 'cli',
      startupLaunchPreferences: { model: 'gpt-5.6-sol', effort: 'high' }
    })
  })

  it('sends no launch preferences when neither flag is given', async () => {
    answerByMethod([WORKTREE_CREATE_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY])
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([...CREATE_ARGV, '--agent', 'codex', '--json'], '/tmp/repo')

    expect(createCall()).toBeDefined()
    expect(createCall()).not.toHaveProperty('startupLaunchPreferences')
    expect(callMock.mock.calls.some(([method]) => method === 'status.get')).toBe(false)
  })

  it('rejects --model without --agent before creating anything', async () => {
    answerByMethod([WORKTREE_CREATE_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main([...CREATE_ARGV, '--model', 'gpt-5.6-sol', '--json'], '/tmp/repo')

    expect(createCall()).toBeUndefined()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: '--model and --effort require --agent' }
    })
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('refuses a runtime that would silently drop the launch preferences', async () => {
    answerByMethod([])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [...CREATE_ARGV, '--agent', 'codex', '--model', 'gpt-5.6-sol', '--json'],
      '/tmp/repo'
    )

    expect(createCall()).toBeUndefined()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'incompatible_runtime' }
    })
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
