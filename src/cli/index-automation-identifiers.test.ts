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
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('passes positional automation ids to edit, remove, run, and show', async () => {
    queueFixtures(
      callMock,
      okFixture('req_edit_owner', { automation: { id: 'auto-1', name: 'Paused' } }),
      okFixture('req_edit', { automation: { id: 'auto-1', name: 'Paused' } }),
      okFixture('req_remove_owner', { automation: { id: 'auto-1', name: 'Paused' } }),
      okFixture('req_remove', { removed: true, id: 'auto-1' }),
      okFixture('req_run_owner', { automation: { id: 'auto-1', name: 'Paused' } }),
      okFixture('req_run', {
        run: {
          id: 'run-1',
          automationId: 'auto-1',
          title: 'Paused run 1',
          status: 'pending',
          trigger: 'manual',
          scheduledFor: 1,
          workspaceId: null,
          sessionKind: 'terminal',
          chatSessionId: null,
          terminalSessionId: null,
          outputSnapshot: null,
          usage: null,
          error: null,
          startedAt: null,
          dispatchedAt: null,
          createdAt: 1
        }
      }),
      okFixture('req_show', { automation: { id: 'auto-1', name: 'Paused' } })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--disabled', '--json'], '/tmp/repo')
    await main(['automations', 'remove', 'auto-1', '--json'], '/tmp/repo')
    await main(['automations', 'run', 'auto-1', '--json'], '/tmp/repo')
    await main(['automations', 'show', 'auto-1', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'automation.show', { id: 'auto-1' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.update', {
      id: 'auto-1',
      updates: {
        name: undefined,
        prompt: undefined,
        agentId: undefined,
        repo: undefined,
        workspace: undefined,
        workspaceMode: undefined,
        baseBranch: undefined,
        timezone: undefined,
        enabled: false,
        missedRunGraceMinutes: undefined
      }
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'automation.show', { id: 'auto-1' })
    expect(callMock).toHaveBeenNthCalledWith(4, 'automation.delete', {
      id: 'auto-1'
    })
    expect(callMock).toHaveBeenNthCalledWith(5, 'automation.show', { id: 'auto-1' })
    expect(callMock).toHaveBeenNthCalledWith(6, 'automation.runNow', {
      id: 'auto-1'
    })
    expect(callMock).toHaveBeenNthCalledWith(7, 'automation.show', {
      id: 'auto-1'
    })
  })

  it('rejects ambiguous positional and flag automation ids before dispatch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['automations', 'show', 'auto-1', '--id', 'auto-2', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Pass --id either positionally or as a flag, not both.'
      }
    })
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
