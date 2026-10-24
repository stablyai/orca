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
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchFixture, agentLaunchHostFixture } from './agent-launch-test-fixtures'
import { RuntimeClientError } from './runtime-client'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('opts into setup and activation when worktree.create runs hooks', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create', {
        worktree: buildWorktree('/tmp/repo/feature', 'feature', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'feature', '--run-hooks', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'feature',
      displayName: 'feature',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: undefined,
      comment: undefined,
      runHooks: true,
      activate: true,
      navigation: 'host',
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {}
    })
  })

  it('starts an agent worktree through agent.launch, in the background unless activation is explicit', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      agentLaunchHostFixture(),
      agentLaunchFixture('repo-1::/tmp/repo/agent-task', 'The inferred parent contexts conflict.'),
      okFixture('req_show', {
        worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1')
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'agent-task',
        '--agent',
        'codex',
        '--model',
        'gpt-5.5',
        '--effort',
        'high',
        '--prompt',
        'hi',
        '--setup',
        'run',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(3, 'agent.launchReplay', {
      target: {
        kind: 'create-worktree',
        create: {
          repo: 'id:repo-1',
          name: 'agent-task',
          displayName: 'agent-task',
          displayNameKind: 'user',
          baseBranch: undefined,
          linkedIssue: undefined,
          comment: undefined,
          runHooks: false,
          activate: false,
          setupDecision: 'run',
          parentWorktree: undefined,
          cwdParentWorktree: 'id:repo-1::/tmp/repo',
          noParent: false,
          callerTerminalHandle: undefined,
          cliProvenanceRequest: {}
        }
      },
      presentation: 'background',
      agent: 'codex',
      prompt: { text: 'hi', delivery: 'submit' },
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      launchSource: 'cli',
      operationId: expect.any(String)
    })
    expect(callMock).toHaveBeenNthCalledWith(4, 'worktree.show', {
      worktree: 'id:repo-1::/tmp/repo/agent-task'
    })
    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.worktree.path).toBe('/tmp/repo/agent-task')
    expect(printed.result.launch.outcome).toEqual({
      kind: 'structured',
      sessionId: 'codex_1',
      handle: 'agent_1'
    })
    expect(printed.result.launch.warning).toBe('The inferred parent contexts conflict.')
  })

  it('starts the agent the host resolves for --agent default, and names it in the receipt', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      agentLaunchHostFixture(),
      okFixture('req_default', { agent: 'omp', selection: 'configured' }),
      agentLaunchHostFixture(),
      agentLaunchFixture('repo-1::/tmp/repo/agent-task'),
      okFixture('req_show', {
        worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1')
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'agent-task',
        '--agent',
        'default',
        '--prompt',
        'hi',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(3, 'agent.resolveDefault', {
      target: { kind: 'create-worktree', repo: 'id:repo-1' }
    })
    expect(callMock).toHaveBeenNthCalledWith(
      5,
      'agent.launchReplay',
      expect.objectContaining({ agent: 'omp', prompt: { text: 'hi', delivery: 'submit' } })
    )
    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.launch.receipt).toMatchObject({
      agent: 'omp',
      agentSelection: 'configured-default'
    })
  })

  it.each([
    {
      resolution: { agent: null, reason: 'shell_only' },
      capabilities: undefined,
      message: 'set to a plain terminal'
    },
    {
      resolution: { agent: null, reason: 'none_available' },
      capabilities: undefined,
      message: 'No enabled agent is installed'
    },
    {
      resolution: undefined,
      capabilities: ['agent.launch.v2'],
      message: 'cannot resolve --agent default'
    }
  ])(
    'refuses --agent default before creating anything: $message',
    async ({ resolution, capabilities, message }) => {
      queueFixtures(
        callMock,
        worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
        capabilities ? okFixture('req_status', { capabilities }) : agentLaunchHostFixture(),
        ...(resolution ? [okFixture('req_default', resolution)] : [])
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const priorExitCode = process.exitCode

      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          'agent-task',
          '--agent',
          'default',
          '--prompt',
          'hi',
          '--json'
        ],
        '/tmp/repo/src'
      )

      expect(process.exitCode).toBe(1)
      process.exitCode = priorExitCode
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).error.message).toContain(message)
      expect(
        callMock.mock.calls.filter(
          ([method]) => method === 'worktree.create' || String(method).startsWith('agent.launch')
        )
      ).toEqual([])
    }
  )

  it('pins the admitted agent in the recovery command for --agent=default', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      agentLaunchHostFixture(),
      okFixture('req_default', { agent: 'omp', selection: 'configured' }),
      agentLaunchHostFixture()
    )
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_unavailable', 'The Orca runtime closed the connection.')
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 't', '--agent=default', '--json'],
      '/tmp/repo/src'
    )
    process.exitCode = priorExitCode
    const error = JSON.parse(String(logSpy.mock.calls[0]?.[0])).error
    expect(error.data.recoveryCommand.slice(1)).toEqual([
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      't',
      '--agent=omp',
      '--json',
      '--retry-launch',
      error.data.operationId
    ])
  })

  it.each([[['--agent', 'default']], [['--agent=default']]])(
    'refuses %j with --retry-launch before any request',
    async (agentArgs) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const priorExitCode = process.exitCode
      await main(
        [
          'worktree',
          'create',
          '--repo',
          'id:repo-1',
          '--name',
          't',
          ...agentArgs,
          '--retry-launch',
          `${Date.now()}-000000000000000000000000000000ee`,
          '--json'
        ],
        '/tmp/repo'
      )
      expect(process.exitCode).toBe(1)
      process.exitCode = priorExitCode
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).error.message).toContain(
        '--retry-launch cannot use --agent default'
      )
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('names the resolved agent when --pairing-code suppresses the --agent default recovery command', async () => {
    queueFixtures(
      callMock,
      agentLaunchHostFixture(),
      okFixture('req_default', { agent: 'omp', selection: 'configured' }),
      agentLaunchHostFixture()
    )
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_unavailable', 'The Orca runtime closed the connection.')
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        't',
        '--no-parent',
        '--agent',
        'default',
        '--pairing-code',
        'secret-pairing',
        '--json'
      ],
      '/tmp/repo'
    )
    process.exitCode = priorExitCode
    const error = JSON.parse(String(logSpy.mock.calls[0]?.[0])).error
    expect(callMock).toHaveBeenCalledWith(
      'agent.launchReplay',
      expect.objectContaining({ agent: 'omp' })
    )
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect(error.data.recoveryCommand).toBeUndefined()
    expect(error.data.launchRequest.agent).toBe('omp')
    expect(error.data.nextSteps[0]).toContain('same pairing or environment flags')
    expect(error.data.nextSteps[0]).toContain('replace --agent default with --agent omp')
    expect(error.data.nextSteps[0]).toContain(`--retry-launch ${error.data.operationId}`)
    expect(JSON.stringify(error)).not.toContain('secret-pairing')
  })

  it('rejects an empty retry identity before creating a worktree', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'task',
        '--agent',
        'codex',
        '--retry-launch=',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('--retry-launch')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each([
    { capabilities: [] },
    { capabilities: ['agent.launch.v2'] },
    { capabilities: ['agent.launch.v2', 'agent.launch.local-presentation.v1'] }
  ])(
    'falls back to the startup terminal when the host lacks a required launch capability: $capabilities',
    async ({ capabilities }) => {
      queueFixtures(
        callMock,
        worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
        okFixture('req_status', { capabilities }),
        okFixture('req_create', {
          worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1'),
          lineage: null,
          warnings: []
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(
        [
          'worktree',
          'create',
          '--name',
          'agent-task',
          '--agent',
          'codex',
          '--prompt',
          'hi',
          '--activate',
          '--json'
        ],
        '/tmp/repo/src'
      )

      expect(callMock).toHaveBeenNthCalledWith(3, 'worktree.create', {
        repo: 'id:repo-1',
        name: 'agent-task',
        displayName: 'agent-task',
        displayNameKind: 'user',
        baseBranch: undefined,
        linkedIssue: undefined,
        comment: undefined,
        runHooks: false,
        activate: true,
        navigation: 'host',
        parentWorktree: undefined,
        cwdParentWorktree: 'id:repo-1::/tmp/repo',
        noParent: false,
        callerTerminalHandle: undefined,
        cliProvenanceRequest: {},
        startupAgent: 'codex',
        startupPrompt: 'hi',
        launchSource: 'cli'
      })
    }
  )

  it('rejects prompt without agent on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--prompt', 'hi', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--prompt requires --agent'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects unknown agents on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--agent', 'wat', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Unknown TUI agent "wat"'
      }
    })
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects agent, prompt, and setup flags without values on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--agent'],
      '/tmp/repo'
    )
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --agent'
    )

    callMock.mockClear()
    logSpy.mockClear()
    errSpy.mockClear()
    process.exitCode = priorExitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--agent',
        'codex',
        '--prompt'
      ],
      '/tmp/repo'
    )
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      '--prompt requires a value'
    )

    callMock.mockClear()
    logSpy.mockClear()
    errSpy.mockClear()
    process.exitCode = priorExitCode

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--setup'],
      '/tmp/repo'
    )
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.create')).toBe(false)
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --setup'
    )

    process.exitCode = priorExitCode
  })

  it('rejects contradictory setup flags on worktree.create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'child',
        '--run-hooks',
        '--setup',
        'skip',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Choose either --run-hooks or --setup run'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
