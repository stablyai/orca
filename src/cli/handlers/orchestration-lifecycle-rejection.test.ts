import { afterEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

afterEach(() => {
  process.exitCode = originalExitCode
})

it('prints a lifecycle rejection and exits unsuccessfully', async () => {
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

  await ORCHESTRATION_HANDLERS['orchestration send']({
    flags: new Map([
      ['from', 'term_foreign'],
      ['to', 'term_coord'],
      ['subject', 'done'],
      ['type', 'worker_done']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)

  expect(process.exitCode).toBe(1)
  const formatter = vi.mocked(printResult).mock.calls[0]?.[2]
  expect(formatter?.(response.result)).toBe(
    'Rejected msg_rejected: dispatch ctx_1 expected the assigned pane'
  )
})
