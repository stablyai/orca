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
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchFixture, agentLaunchHostFixture } from './agent-launch-test-fixtures'

const WORKTREE_ID = 'repo-1::/tmp/repo'

async function runRefused(argv: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const priorExitCode = process.exitCode
  await main(argv, '/tmp/repo')
  expect(process.exitCode).toBe(1)
  process.exitCode = priorExitCode
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

  it('starts an agent in the current worktree through agent.launch', async () => {
    queueFixtures(
      callMock,
      okFixture('req_folders', { folderWorkspaces: [] }),
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      agentLaunchHostFixture(),
      agentLaunchFixture(WORKTREE_ID)
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'agent',
        'launch',
        '--agent',
        'codex',
        '--model',
        'gpt-5.5',
        '--effort',
        'high',
        '--prompt',
        'Write the design doc',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(4, 'agent.launchReplay', {
      target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
      presentation: 'background',
      agent: 'codex',
      prompt: { text: 'Write the design doc', delivery: 'submit' },
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      launchSource: 'cli',
      operationId: expect.any(String)
    })
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result.receipt.reason).toBe('user_default')
  })

  it('switches to the new tab only with --focus', async () => {
    queueFixtures(callMock, agentLaunchHostFixture(), agentLaunchFixture(WORKTREE_ID))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['agent', 'launch', '--agent', 'claude', '--worktree', `id:${WORKTREE_ID}`, '--focus'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('agent.launchReplay', {
      target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
      presentation: 'focused',
      agent: 'claude',
      launchSource: 'cli',
      operationId: expect.any(String)
    })
  })

  it('honors the paired execution host for agent launch', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'server-1')
    queueFixtures(callMock, agentLaunchHostFixture(), agentLaunchFixture('folder:server-folder'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'agent',
        'launch',
        '--agent',
        'codex',
        '--environment',
        'server-1',
        '--worktree',
        'id:folder:server-folder',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(undefined, 'server-1')
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({ target: { kind: 'existing', worktree: 'id:folder:server-folder' } })
    )
    expect(callMock).not.toHaveBeenCalledWith('folderWorkspace.list')
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
    const previousExitCode = process.exitCode
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
    process.exitCode = previousExitCode
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
    expect(launchCalls()).toHaveLength(1)
  })

  it.each([['--retry-launch'], ['--retry-launch', ' ']])(
    'rejects an invalid retry identity before launching: %j',
    async (...retryArgs) => {
      const output = await runRefused([
        'agent',
        'launch',
        '--agent',
        'codex',
        '--worktree',
        `id:${WORKTREE_ID}`,
        ...retryArgs,
        '--json'
      ])
      expect(JSON.parse(output).error).toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('--retry-launch')
      })
      expect(callMock).not.toHaveBeenCalled()
    }
  )

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
    expect(launchCalls()).toHaveLength(1)
  })

  it('uses the caller folder identity after validating its native host and enclosing path', async () => {
    process.env.ORCA_WORKSPACE_ID = 'folder:caller'
    queueFixtures(
      callMock,
      okFixture('folders', {
        folderWorkspaces: [
          { id: 'caller', folderPath: '/tmp/folder', projectGroupId: 'local' },
          { id: 'nested', folderPath: '/tmp/folder/src', projectGroupId: 'local' },
          { id: 'remote', folderPath: '/tmp/folder', projectGroupId: 'ssh' }
        ]
      }),
      okFixture('groups', { groups: [{ id: 'local' }, { id: 'ssh', connectionId: 'ssh-1' }] }),
      okFixture('repos', { repos: [] }),
      agentLaunchHostFixture(),
      agentLaunchFixture('folder:caller')
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agent', 'launch', '--agent', 'codex', '--json'], '/tmp/folder/src/nested')
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({ target: { kind: 'existing', worktree: 'id:folder:caller' } })
    )
    expect(callMock).not.toHaveBeenCalledWith('worktree.list', expect.anything())
  })

  it('ignores an inherited remote folder identity and uses the local Git fallback', async () => {
    process.env.ORCA_WORKSPACE_ID = 'folder:remote'
    queueFixtures(
      callMock,
      okFixture('folders', {
        folderWorkspaces: [{ id: 'remote', folderPath: '/tmp/repo', projectGroupId: 'ssh' }]
      }),
      okFixture('groups', { groups: [{ id: 'ssh', connectionId: 'ssh-1' }] }),
      okFixture('repos', { repos: [] }),
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      agentLaunchHostFixture(),
      agentLaunchFixture(WORKTREE_ID)
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['agent', 'launch', '--agent', 'codex', '--json'], '/tmp/repo/src')
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({ target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` } })
    )
  })

  it('refuses on a host older than agent.launch instead of opening a terminal', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))

    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'codex',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--json'
    ])

    expect(output).toContain('cannot start agents from the CLI')
    expect(launchCalls()).toEqual([])
  })

  it('refuses a model on a host older than agent.launch rather than dropping it', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))

    const output = await runRefused([
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'design',
      '--no-parent',
      '--agent',
      'codex',
      '--model',
      'gpt-5.5',
      '--json'
    ])

    expect(output).toContain('cannot start an agent on a chosen model or effort')
    expect(launchCalls()).toEqual([])
  })

  it.each([
    [['--agent', 'codex', '--effort', 'high'], '--effort requires --model'],
    [['--model', 'gpt-5.5'], '--model requires --agent'],
    [['--agent', 'codex', '--model', 'gpt-5.5', '--effort', 'turbo'], 'does not support effort']
  ])('refuses %j before creating anything', async (flags, message) => {
    const output = await runRefused([
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'design',
      '--no-parent',
      ...flags,
      '--json'
    ])

    expect(output).toContain(message)
    expect(callMock).not.toHaveBeenCalled()
  })
})
