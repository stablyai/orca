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

vi.mock('./runtime/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

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
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime/types'
import { okFixture, queueFixtures } from './runtime/fixtures/runtime-rpc-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchFixture, agentLaunchHostFixture } from './agents/agent-launch-test-fixtures'

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

  it('resolves default for the selected folder workspace on the paired host', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'server-1')
    queueFixtures(
      callMock,
      agentLaunchHostFixture(['project.default-agent.v1']),
      okFixture('req_default', {
        agent: 'claude',
        source: 'project',
        projectId: 'project-b',
        projectName: 'B'
      }),
      agentLaunchFixture('folder:server-folder')
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'agent',
        'launch',
        '--agent',
        'default',
        '--environment',
        'server-1',
        '--worktree',
        'id:folder:server-folder',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenCalledWith('agent.resolveDefault', {
      worktree: 'id:folder:server-folder'
    })
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({
        agent: 'claude',
        target: { kind: 'existing', worktree: 'id:folder:server-folder' }
      })
    )
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result.resolvedAgent).toEqual({
      agent: 'claude',
      source: 'project',
      projectId: 'project-b',
      projectName: 'B'
    })
  })

  it('refuses a default blank terminal before launching', async () => {
    queueFixtures(
      callMock,
      agentLaunchHostFixture(['project.default-agent.v1']),
      okFixture('req_default', { agent: null, source: 'project', projectId: 'project-b' })
    )
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'default',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--json'
    ])
    expect(JSON.parse(output).error.code).toBe('invalid_argument')
    expect(callMock).toHaveBeenCalledWith('agent.resolveDefault', {
      worktree: 'id:repo-1::/tmp/repo'
    })
    expect(launchCalls()).toEqual([])
  })

  it('refuses default on an older host before launching', async () => {
    queueFixtures(callMock, agentLaunchHostFixture())
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'default',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--json'
    ])
    expect(JSON.parse(output).error.code).toBe('incompatible_runtime')
    expect(callMock).not.toHaveBeenCalledWith('agent.resolveDefault', expect.anything())
    expect(launchCalls()).toEqual([])
  })

  it('puts the resolved agent into the replay command after a lost launch reply', async () => {
    queueFixtures(
      callMock,
      agentLaunchHostFixture(['project.default-agent.v1']),
      okFixture('req_default', { agent: 'claude', source: 'global' })
    )
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_unavailable', 'The Orca runtime closed the connection.')
    )
    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'default',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--json'
    ])
    const error = JSON.parse(output).error
    expect(error.code).toBe('agent_session_operation_unknown')
    expect(error.data.recoveryCommand).toContain('claude')
    expect(error.data.recoveryCommand).not.toContain('default')
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({ agent: 'claude', operationId: error.data.operationId })
    )
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
