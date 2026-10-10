import { describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

async function runTaskListBrief(): Promise<{
  result: { tasks: { spec: string; spec_truncated: boolean }[] }
}> {
  vi.mocked(printResult).mockClear()
  await ORCHESTRATION_HANDLERS['orchestration task-list']({
    flags: new Map([['brief', true]]),
    client: { call: callMock },
    json: true
  } as never)
  return vi.mocked(printResult).mock.calls[0]?.[0] as {
    result: { tasks: { spec: string; spec_truncated: boolean }[] }
  }
}

describe('orchestration task-list brief output', () => {
  it('requests server-side brief and falls back client-side for older runtimes', async () => {
    callMock.mockReset().mockResolvedValue({
      result: {
        // No spec_truncated field — the pre-brief-runtime signature.
        tasks: [{ id: 'task_1', spec: `First line\n${'detail '.repeat(40)}`, status: 'ready' }],
        count: 1
      }
    })

    const response = await runTaskListBrief()

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.taskList',
      expect.objectContaining({ brief: true })
    )
    expect(response.result.tasks[0].spec).toHaveLength(160)
    expect(response.result.tasks[0].spec_truncated).toBe(true)
  })

  it('passes server-abbreviated rows through untouched', async () => {
    const serverTasks = [
      { id: 'task_1', spec: 'already brief…', status: 'ready', spec_truncated: true }
    ]
    callMock.mockReset().mockResolvedValue({ result: { tasks: serverTasks, count: 1 } })

    const response = await runTaskListBrief()

    // Why: re-abbreviating a server-truncated spec would flip spec_truncated
    // back to false (the truncated text fits the cap).
    expect(response.result.tasks).toBe(serverTasks)
  })
})
