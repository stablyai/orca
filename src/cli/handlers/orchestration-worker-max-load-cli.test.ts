import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import type { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_WORKER_START_MAX_LOAD_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

describe('orchestration worker-start --max-load CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker-start reads only `call`; RuntimeClient is a class, so a structural double cannot satisfy it without the cast.
  const client = { call: callMock } as unknown as RuntimeClient

  const invokeWorkerStart = (entries: [string, string][]) =>
    ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['from', 'term_coord'],
        ...entries
      ]),
      client,
      cwd: '/tmp/repo',
      json: true
    })

  it('capability-gates and forwards --max-load as a ratio', async () => {
    callMock
      .mockResolvedValueOnce({
        result: { capabilities: [ORCHESTRATION_WORKER_START_MAX_LOAD_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        result: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready' }
      })

    await invokeWorkerStart([['max-load', '0.7']])

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({ maxLoad: 0.7 })
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('fails before worker-start when the runtime would drop --max-load', async () => {
    callMock.mockResolvedValueOnce({ result: { capabilities: [] } })

    await expect(invokeWorkerStart([['max-load', '0.7']])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('skips the capability probe when --max-load is absent', async () => {
    callMock.mockResolvedValueOnce({
      result: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready' }
    })

    await invokeWorkerStart([])

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({ maxLoad: undefined })
    )
  })

  it.each(['0', '-1', 'abc', '1e3', '0x1', ''])(
    'rejects --max-load %j before any RPC',
    async (raw) => {
      await expect(invokeWorkerStart([['max-load', raw]])).rejects.toMatchObject({
        code: 'invalid_argument'
      })
      expect(callMock).not.toHaveBeenCalled()
    }
  )
})
