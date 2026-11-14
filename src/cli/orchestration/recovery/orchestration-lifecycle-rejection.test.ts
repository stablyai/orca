import { afterEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'

afterEach(() => {
  process.exitCode = originalExitCode
  vi.clearAllMocks()
  callMock.mockReset()
})

it('fails closed when an older runtime leaves worker_done dispatched without a verdict', async () => {
  callMock
    .mockResolvedValueOnce({
      result: { message: { id: 'msg_unconfirmed', run_id: 'run_1' } }
    })
    .mockResolvedValueOnce({
      result: { dispatch: { id: 'ctx_1', status: 'dispatched' } }
    })
    .mockResolvedValueOnce({ result: { tasks: [] } })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_foreign'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'succeeded']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  ).rejects.toMatchObject({ code: 'operation_unknown' })

  expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.dispatchShow', { task: 'task_1' })
  expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.taskList', {
    status: 'completed',
    run: 'run_1'
  })
})

it('normalizes compatibility-read failures to operation_unknown', async () => {
  callMock
    .mockResolvedValueOnce({
      result: { message: { id: 'msg_unconfirmed', run_id: 'run_1' } }
    })
    .mockRejectedValueOnce(new Error('runtime disconnected'))
    .mockResolvedValueOnce({ result: { tasks: [] } })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_worker'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'succeeded']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  ).rejects.toMatchObject({ code: 'operation_unknown' })
})

it('preserves the worker_done mutation identity when post-verification fails', async () => {
  callMock
    .mockResolvedValueOnce({
      result: {
        message: { id: 'msg_unconfirmed', run_id: 'run_1' },
        mutation: { requestId: 'mutation_worker_done', replayed: false }
      }
    })
    .mockResolvedValueOnce({
      result: { dispatch: { id: 'ctx_1', status: 'dispatched' } }
    })
    .mockResolvedValueOnce({ result: { tasks: [] } })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_worker'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'succeeded']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  ).rejects.toMatchObject({
    code: 'operation_unknown',
    data: { orchestrationRequestId: 'mutation_worker_done' },
    message: expect.stringMatching(
      /Do not send a new completion.*--retry-request mutation_worker_done/s
    )
  })
})

it('rejects an unrelated failed Dispatch that left its Task blocked', async () => {
  callMock
    .mockResolvedValueOnce({
      result: { message: { id: 'msg_after_stop', run_id: 'run_1' } }
    })
    .mockResolvedValueOnce({ result: { dispatch: { id: 'ctx_1', status: 'failed' } } })
    .mockResolvedValueOnce({ result: { tasks: [] } })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_worker'],
        ['subject', 'failed'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'failed']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  ).rejects.toMatchObject({ code: 'operation_unknown' })
})

it('rejects a terminal Dispatch with the wrong identity', async () => {
  callMock
    .mockResolvedValueOnce({
      result: { message: { id: 'msg_stale', run_id: 'run_1' } }
    })
    .mockResolvedValueOnce({
      result: { dispatch: { id: 'ctx_replacement', status: 'completed' } }
    })
    .mockResolvedValueOnce({
      result: {
        tasks: [
          {
            id: 'task_1',
            status: 'completed',
            result: JSON.stringify({
              provenance: 'worker_report',
              messageId: 'msg_stale',
              outcome: 'succeeded'
            })
          }
        ]
      }
    })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_worker'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'succeeded']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  ).rejects.toMatchObject({ code: 'operation_unknown' })
})
