import { afterEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const printResultMock = vi.hoisted(() => vi.fn())
vi.mock('../format', () => ({ printResult: printResultMock }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { orchestrationTestContext } from './orchestration-handler-test-context'

afterEach(() => {
  callMock.mockReset()
  printResultMock.mockReset()
})

it('accepts an explicitly attested legacy worker-server settlement', async () => {
  const result = {
    relay: {
      messageId: 'relay_legacy_done',
      sequence: 1,
      dispatchId: 'ctx_legacy',
      destination: 'run_home',
      accepted: true
    },
    lifecycle: {
      action: 'completed',
      authority: 'worker_server_legacy'
    }
  }
  callMock.mockResolvedValueOnce({ result })

  await ORCHESTRATION_HANDLERS['orchestration send'](
    orchestrationTestContext(
      callMock,
      new Map<string, string | boolean>([
        ['full', true],
        ['from', 'term_worker'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_legacy'],
        ['dispatch-id', 'ctx_legacy'],
        ['outcome', 'succeeded']
      ]),
      true
    )
  )

  expect(callMock).toHaveBeenCalledOnce()
  expect(callMock).toHaveBeenCalledWith(
    'orchestration.send',
    expect.objectContaining({
      from: 'term_worker',
      subject: 'done',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: 'task_legacy',
        dispatchId: 'ctx_legacy',
        outcome: 'succeeded'
      }),
      waitForLifecycleSettlement: true
    }),
    { orchestrationRequestId: expect.any(String) }
  )
  expect(printResultMock).toHaveBeenCalledWith({ result }, true, expect.any(Function))
})

it('rejects an unattested relay settlement', async () => {
  callMock.mockResolvedValueOnce({
    result: {
      relay: {
        messageId: 'relay_unattested',
        sequence: 1,
        dispatchId: 'ctx_legacy',
        destination: 'run_home',
        accepted: true
      },
      lifecycle: { action: 'completed' }
    }
  })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration send'](
      orchestrationTestContext(
        callMock,
        new Map<string, string | boolean>([
          ['full', true],
          ['from', 'term_worker'],
          ['subject', 'done'],
          ['type', 'worker_done'],
          ['task-id', 'task_legacy'],
          ['dispatch-id', 'ctx_legacy'],
          ['outcome', 'succeeded']
        ]),
        true
      )
    )
  ).rejects.toMatchObject({ code: 'operation_unknown' })
  expect(callMock).toHaveBeenCalledOnce()
  expect(printResultMock).not.toHaveBeenCalled()
})
