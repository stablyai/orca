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
        '--branch',
        'DAT-111-agent-task',
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
          branchNameOverride: 'DAT-111-agent-task',
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
