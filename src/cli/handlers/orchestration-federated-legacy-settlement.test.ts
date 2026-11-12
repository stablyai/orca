import { afterEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const printResultMock = vi.hoisted(() => vi.fn())
vi.mock('../command-result-output', () => ({ printResult: printResultMock }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { orchestrationTestContext } from './orchestration-handler-test-context'

afterEach(() => {
  callMock.mockReset()
  printResultMock.mockReset()
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
