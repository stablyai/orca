import { afterEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { printResult } from '../format'
import { lifecycleRejectionRecovery } from '../orchestration-lifecycle-rejection-recovery'
import { ORCHESTRATION_HANDLERS } from './orchestration'

afterEach(() => {
  process.exitCode = originalExitCode
  vi.clearAllMocks()
  callMock.mockReset()
})

it('raises a lifecycle rejection for the CLI error boundary', async () => {
  const response = {
    result: {
      message: { id: 'msg_rejected' },
      lifecycle: {
        action: 'rejected' as const,
        code: 'sender_not_assignee',
        reason: 'dispatch ctx_1 expected the assigned pane'
      }
    }
  }
  callMock.mockResolvedValueOnce(response)

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_foreign'],
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)
  ).rejects.toMatchObject({
    code: 'sender_not_assignee',
    message: 'dispatch ctx_1 expected the assigned pane'
  })
  expect(printResult).not.toHaveBeenCalled()
})

it('raises a Run-home relay rejection for the CLI error boundary', async () => {
  callMock.mockResolvedValueOnce({
    result: {
      relay: {
        messageId: 'relay_rejected',
        sequence: 1,
        dispatchId: 'ctx_1',
        destination: 'run_home',
        accepted: true
      },
      lifecycle: {
        action: 'rejected',
        code: 'task_dispatch_mismatch',
        reason: 'wrong task',
        authority: 'run_home'
      }
    }
  })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_worker'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_wrong'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'succeeded']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
  ).rejects.toMatchObject({ code: 'task_dispatch_mismatch', message: 'wrong task' })
  expect(printResult).not.toHaveBeenCalled()
})

it('accepts an explicit current settlement without a compatibility read', async () => {
  callMock.mockResolvedValueOnce({
    result: { message: { id: 'msg_done' }, lifecycle: { action: 'completed' } }
  })

  await ORCHESTRATION_HANDLERS['orchestration send']({
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

  expect(callMock).toHaveBeenCalledOnce()
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

it('accepts a legacy response only after the authoritative dispatch is terminal', async () => {
  callMock
    .mockResolvedValueOnce({
      result: { message: { id: 'msg_legacy_completed', run_id: 'run_1' } }
    })
    .mockResolvedValueOnce({
      result: { dispatch: { id: 'ctx_1', status: 'completed' } }
    })
    .mockResolvedValueOnce({
      result: {
        tasks: [
          {
            id: 'task_1',
            status: 'completed',
            result: JSON.stringify({
              provenance: 'worker_report',
              messageId: 'msg_legacy_completed',
              outcome: 'succeeded'
            })
          }
        ]
      }
    })

  await ORCHESTRATION_HANDLERS['orchestration send']({
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

  expect(callMock).toHaveBeenCalledTimes(3)
  expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.dispatchShow', { task: 'task_1' })
})

it('accepts a legacy failed report only after the authoritative dispatch failed', async () => {
  callMock
    .mockResolvedValueOnce({
      result: { message: { id: 'msg_legacy_failed', run_id: 'run_1' } }
    })
    .mockResolvedValueOnce({ result: { dispatch: { id: 'ctx_1', status: 'failed' } } })
    .mockResolvedValueOnce({
      result: {
        tasks: [
          {
            id: 'task_1',
            status: 'failed',
            result: JSON.stringify({
              provenance: 'worker_report',
              messageId: 'msg_legacy_failed',
              outcome: 'failed'
            })
          }
        ]
      }
    })

  await ORCHESTRATION_HANDLERS['orchestration send']({
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

  expect(callMock).toHaveBeenCalledTimes(3)
})

it('accepts an idempotent retry whose first report already settled', async () => {
  callMock
    .mockResolvedValueOnce({
      result: {
        message: { id: 'msg_retry', run_id: 'run_1', from_handle: 'term_worker' }
      }
    })
    .mockResolvedValueOnce({ result: { dispatch: { id: 'ctx_1', status: 'completed' } } })
    .mockResolvedValueOnce({
      result: {
        tasks: [
          {
            id: 'task_1',
            status: 'completed',
            result: JSON.stringify({
              provenance: 'worker_report',
              messageId: 'msg_first',
              reportedBy: 'term_worker',
              outcome: 'succeeded'
            })
          }
        ]
      }
    })

  await ORCHESTRATION_HANDLERS['orchestration send']({
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

  expect(callMock).toHaveBeenCalledTimes(3)
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

/** REJECTED_WORKER_DONE_NOT_TERMINAL — observed on Dispatch `ctx_de358c6c53b2`:
 *  the rejection carried a code and a sentence and nothing else, so it read as
 *  a terminal failure even though the Dispatch was still active. */
it('tells a rejected worker the Dispatch is still active and how to recover', async () => {
  callMock.mockResolvedValueOnce({
    result: {
      message: { id: 'msg_rejected' },
      lifecycle: {
        action: 'rejected' as const,
        code: 'dispatch_capability_invalid',
        reason: 'The Dispatch capability is missing.'
      }
    }
  })

  const error = await ORCHESTRATION_HANDLERS['orchestration send']({
    flags: new Map([
      ['from', 'term_worker'],
      ['subject', 'done'],
      ['type', 'worker_done'],
      ['outcome', 'succeeded']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never).catch((thrown: unknown) => thrown)

  const data = (error as { data?: { dispatchSettled?: boolean; nextSteps?: string[] } }).data
  expect(data?.dispatchSettled).toBe(false)
  expect(data?.nextSteps?.[0]).toMatch(/REJECTED/)
  expect(data?.nextSteps?.some((step) => step.includes('--dispatch-capability'))).toBe(true)
})

it('offers a bounded, actionable recovery for every lifecycle rejection code', () => {
  for (const code of [
    'dispatch_capability_invalid',
    'sender_not_assignee',
    'task_dispatch_mismatch'
  ]) {
    const recovery = lifecycleRejectionRecovery(code)
    expect(recovery, `no recovery for ${code}`).toBeDefined()
    expect(recovery?.dispatchSettled).toBe(false)
    expect(recovery?.nextSteps.length).toBeGreaterThan(1)
    expect(recovery?.nextSteps.length).toBeLessThanOrEqual(4)
    expect(recovery?.nextSteps.some((step) => step.includes('orca orchestration'))).toBe(true)
    expect(recovery?.nextSteps[0]).toMatch(/REJECTED/)
  }
  expect(lifecycleRejectionRecovery('dispatch_inactive')).toBeUndefined()
  expect(lifecycleRejectionRecovery(undefined)).toBeUndefined()
})
