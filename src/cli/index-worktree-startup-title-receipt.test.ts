import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
  return createRuntimeClientModuleMock(mocks)
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: mocks.addEnvironmentFromPairingCodeMock,
  listEnvironments: mocks.listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(mocks.spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('startup title receipt compatibility', () => {
  useWorktreeAwarenessEnvironment(mocks)

  it.each([
    { title: undefined, expectedWarning: true },
    { title: null, expectedWarning: true },
    { title: 'Other title', expectedWarning: true },
    { title: 'Review tests', expectedWarning: false }
  ])('reports whether the host confirmed the title (%j)', async ({ title, expectedWarning }) => {
    queueFixtures(
      mocks.callMock,
      okFixture('created', {
        worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1'),
        warning: 'Existing setup warning.',
        agentTerminalHandle: 'term-agent',
        startupTerminal: {
          spawned: true,
          handle: 'term-agent',
          ...(title !== undefined ? { title } : {})
        }
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'agent-task',
        '--no-parent',
        '--agent',
        'claude',
        '--title',
        'Review tests',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(mocks.callMock).toHaveBeenCalledTimes(1)
    const output = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(output.ok).toBe(true)
    expect(output.result.warning).toContain('Existing setup warning.')
    expect(output.result.warning.includes('did not confirm')).toBe(expectedWarning)
    if (expectedWarning) {
      expect(output.result.warning).toContain('do not repeat worktree create')
    }
  })

  it('keeps older-host output unchanged when no title was requested', async () => {
    queueFixtures(
      mocks.callMock,
      okFixture('created', {
        worktree: buildWorktree('/tmp/repo/agent-task', 'agent-task', 'abc', 'repo-1'),
        agentTerminalHandle: 'term-agent'
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'agent-task',
        '--no-parent',
        '--agent',
        'claude',
        '--json'
      ],
      '/tmp/repo'
    )
    expect(mocks.callMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.warning).toBeUndefined()
  })
})
