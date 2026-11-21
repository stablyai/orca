import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

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

vi.mock('../runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('../runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

vi.mock('../runtime/pairing/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('../index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from '../index'
import { RuntimeClientError } from '../runtime/connection/types'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'
import { useWorktreeAwarenessEnvironment } from '../index-test-harness'
import { agentLaunchFixture, agentLaunchHostFixture } from '../agents/agent-launch-test-fixtures'

const ORIGINAL_EXIT_CODE = process.exitCode

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE
})

const LaunchParams = z.object({
  agent: z.string(),
  prompt: z.object({ text: z.string() }),
  target: z.object({
    kind: z.string(),
    worktree: z.string().optional(),
    create: z.record(z.string(), z.unknown()).optional()
  })
})

function launches(): z.infer<typeof LaunchParams>[] {
  return callMock.mock.calls
    .filter(([method]) => String(method).startsWith('agent.launch') || method === 'worktree.create')
    .map(([, params]) => LaunchParams.parse(params))
}

function answerLaunches(failOn?: number): void {
  let launched = 0
  callMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'status.get') {
      return agentLaunchHostFixture()
    }
    if (method.startsWith('agent.launch')) {
      launched++
      if (launched === failOn) {
        throw new RuntimeClientError(
          'runtime_unavailable',
          'The Orca runtime closed the connection.'
        )
      }
      const { create } = LaunchParams.parse(params).target
      return agentLaunchFixture(`repo-1::/tmp/${String(create?.name)}`)
    }
    return okFixture('req_other', {})
  })
}

async function run(argv: string[]): Promise<{ output: string; exitCode: typeof process.exitCode }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await main(argv, '/tmp/repo')
  return {
    output: [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n'),
    exitCode: process.exitCode
  }
}

const CREATE_ARGS = ['worktree', 'create', '--repo', 'id:repo-1', '--no-parent']

describe('orca worktree create --agents', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('starts one worktree per agent from the same base with the same prompt', async () => {
    answerLaunches()
    const { output } = await run([
      ...CREATE_ARGS,
      '--name',
      'fix',
      '--base-branch',
      'origin/main',
      '--agents',
      'claude,codex,claude',
      '--prompt',
      'Fix the login test',
      '--json'
    ])
    expect(
      launches().map((params) => ({
        agent: params.agent,
        prompt: params.prompt.text,
        create: params.target.create
      }))
    ).toEqual(
      [
        ['claude', 'fix-claude-1'],
        ['codex', 'fix-codex'],
        ['claude', 'fix-claude-2']
      ].map(([agent, name]) => ({
        agent,
        prompt: 'Fix the login test',
        create: expect.objectContaining({
          repo: 'id:repo-1',
          baseBranch: 'origin/main',
          name,
          displayName: name
        })
      }))
    )
    expect(
      JSON.parse(output).result.attempts.map(
        (attempt: { worktreeId: string }) => attempt.worktreeId
      )
    ).toEqual(['repo-1::/tmp/fix-claude-1', 'repo-1::/tmp/fix-codex', 'repo-1::/tmp/fix-claude-2'])
  })

  it('stops at a lost launch reply, names started attempts and recovers only that attempt', async () => {
    answerLaunches(2)
    const { output, exitCode } = await run([
      ...CREATE_ARGS,
      '--name',
      'fix',
      '--agents',
      'claude,codex,gemini',
      '--prompt',
      'Fix it',
      '--json'
    ])
    expect(exitCode).toBe(1)
    const error = JSON.parse(output).error
    expect(error.code).toBe('agent_session_operation_unknown')
    expect(error.data.startedAttempts).toEqual([
      expect.objectContaining({ agent: 'claude', name: 'fix-claude' })
    ])
    expect(error.data.recoveryCommand.slice(1)).toEqual([
      ...CREATE_ARGS,
      '--name',
      'fix-codex',
      '--agent',
      'codex',
      '--prompt',
      'Fix it',
      '--json',
      '--retry-launch',
      error.data.operationId
    ])
    expect(launches()).toHaveLength(2)
  })
})

describe('orca worktree compare', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  function answerShows(hosts: Record<string, string>): void {
    callMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'status.get') {
        return agentLaunchHostFixture()
      }
      if (method === 'worktree.show') {
        const id = String(params.worktree).replace(/^id:/, '')
        const path = id.split('::')[1]
        return okFixture('req_show', {
          worktree: {
            id,
            hostId: hosts[id],
            baseRef: 'origin/main',
            git: { path, branch: `refs/heads${path}` }
          }
        })
      }
      if (method.startsWith('agent.launch')) {
        return agentLaunchFixture('repo-1::/tmp/judge')
      }
      return okFixture('req_other', {})
    })
  }

  const COMPARE_ARGS = [
    'worktree',
    'compare',
    '--worktree',
    'id:repo-1::/tmp/fix-claude',
    '--worktree',
    'id:repo-1::/tmp/fix-codex',
    '--agent',
    'claude',
    '--judge-worktree',
    'id:repo-1::/tmp/judge',
    '--json'
  ]

  it('starts the judge in the chosen workspace with every candidate checkout in its prompt', async () => {
    answerShows({})
    await run(COMPARE_ARGS)
    const [launch] = launches()
    expect(launch).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:repo-1::/tmp/judge' }
    })
    const prompt = launch.prompt.text
    for (const path of ['/tmp/fix-claude', '/tmp/fix-codex']) {
      expect(prompt).toContain(`${path} (branch ${path.slice(1)}, base origin/main)`)
    }
  })

  it('refuses candidates on a different host than the judge', async () => {
    answerShows({
      'repo-1::/tmp/fix-claude': 'local',
      'repo-1::/tmp/fix-codex': 'ssh:box',
      'repo-1::/tmp/judge': 'local'
    })
    const { output, exitCode } = await run(COMPARE_ARGS)
    expect(exitCode).toBe(1)
    expect(JSON.parse(output).error.message).toContain('/tmp/fix-codex is on ssh:box')
    expect(launches()).toEqual([])
  })
})
