import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

describe('orchestration task-list bounded inventory', () => {
  const invokeTaskList = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags,
      client: { call: callMock },
      json: true
    } as never)

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({
      result: {
        tasks: [{ id: 'task_1', title: 'Task task_1', status: 'ready' }],
        totalCount: 2,
        nextCursor: 'next-cursor',
        truncated: true
      }
    })
    vi.mocked(printResult).mockClear()
  })

  it('maps canonical limit and cursor flags to the bounded RPC request', async () => {
    await invokeTaskList(
      new Map<string, string | boolean>([
        ['limit', '1'],
        ['cursor', 'next-cursor']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.taskList', {
      limit: 1,
      cursor: 'next-cursor'
    })
    expect(vi.mocked(printResult).mock.calls[0]?.[0]).toMatchObject({
      result: { totalCount: 2, truncated: true }
    })
  })

  it('fails closed when an older runtime returns the legacy task shape', async () => {
    callMock.mockResolvedValueOnce({
      result: {
        tasks: [{ id: 'task_1', spec: 'private task specification', status: 'ready' }],
        count: 1
      }
    })

    await expect(invokeTaskList(new Map([['limit', '1']]))).rejects.toThrow(/bounded inventory/)
    expect(vi.mocked(printResult)).not.toHaveBeenCalled()
  })

  it.each(['01', '1e2', '0', '1001'])('rejects non-canonical bounded limit %s', async (limit) => {
    await expect(invokeTaskList(new Map([['limit', limit]]))).rejects.toThrow(/--limit/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each([
    new Map<string, string | boolean>([['cursor', 'next-cursor']]),
    new Map<string, string | boolean>([
      ['limit', '1'],
      ['status', 'ready']
    ]),
    new Map<string, string | boolean>([
      ['limit', '1'],
      ['ready', true]
    ]),
    new Map<string, string | boolean>([
      ['limit', '1'],
      ['brief', true]
    ])
  ])('rejects bounded inventory flag conflicts', async (flags) => {
    await expect(invokeTaskList(flags)).rejects.toThrow()
    expect(callMock).not.toHaveBeenCalled()
  })
})
