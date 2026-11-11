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
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import { queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchHostFixture } from './agent-launch-test-fixtures'

const WORKTREE_ID = 'repo-1::/tmp/repo'
const ORIGINAL_EXIT_CODE = process.exitCode

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE
})

async function runRefused(argv: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await main(argv, '/tmp/repo')
  expect(process.exitCode).toBe(1)
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
}

function launchCalls(): unknown[][] {
  return callMock.mock.calls.filter(
    ([method]) =>
      method === 'agent.launchReplay' || method === 'agent.launch' || method === 'worktree.create'
  )
}

describe('orca cli agent launch', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('returns an exact recovery command and removes blind retry advice after a lost reply', async () => {
    queueFixtures(callMock, agentLaunchHostFixture())
    callMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'runtime_unavailable',
        'The Orca runtime closed the connection before responding. Restart Orca and try again.'
      )
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const args = [
      'agent',
      'launch',
      '--agent',
      'codex',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--prompt',
      'Fix it',
      '--json'
    ]
    await main(args, '/tmp/repo')
    const error = JSON.parse(String(logSpy.mock.calls[0]?.[0])).error
    expect(error.code).toBe('agent_session_operation_unknown')
    expect(error.data.retrySafe).toBe(true)
    expect(error.data.recoveryCommand).toEqual([
      expect.any(String),
      ...args,
      '--retry-launch',
      error.data.operationId
    ])
    expect(JSON.stringify(error)).not.toContain('Restart Orca and try again')
    expect(launchCalls()).toEqual([
      ['agent.launchReplay', expect.objectContaining({ operationId: error.data.operationId })]
    ])
  })

  it('keeps recovery identity when an older replacement host refuses a replay method', async () => {
    const operationId = `${Date.now()}-${'c'.repeat(32)}`
    queueFixtures(callMock, agentLaunchHostFixture())
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'refused',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'replacement' }
      })
    )
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'codex',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--retry-launch',
      operationId,
      '--json'
    ])
    const error = JSON.parse(output).error
    expect(error.code).toBe('agent_session_operation_unknown')
    expect(error.data.operationId).toBe(operationId)
    expect(error.data.nextSteps.join(' ')).toContain('never retry as a fresh launch')
    expect(launchCalls()).toEqual([
      ['agent.launchReplay', expect.objectContaining({ operationId })]
    ])
  })
})
