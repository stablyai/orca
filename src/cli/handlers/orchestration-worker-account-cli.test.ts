import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

describe('orchestration worker-start --account', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  const invokeWorkerStart = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('forwards --account to a host that resolves Claude launch accounts', async () => {
    callMock
      .mockResolvedValueOnce({
        result: { capabilities: [CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        result: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready' }
      })

    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'claude'],
        ['account', 'pinned@example.com'],
        ['from', 'term_coord']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({ agent: 'claude', account: 'pinned@example.com' })
    )
  })

  it('fails before worker-start when --account would be stripped or misapplied', async () => {
    callMock.mockResolvedValueOnce({ result: { capabilities: [] } })
    const flags = (agent: string) =>
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', agent],
        ['account', 'acct-b'],
        ['from', 'term_coord']
      ])

    await expect(invokeWorkerStart(flags('claude'))).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    await expect(invokeWorkerStart(flags('codex'))).rejects.toThrow(
      '--account requires --agent claude.'
    )
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('never sends an account field when --account is absent', async () => {
    callMock.mockResolvedValue({
      result: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready' }
    })
    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'claude'],
        ['from', 'term_coord']
      ])
    )
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0]?.[1]).not.toHaveProperty('account')
  })
})
