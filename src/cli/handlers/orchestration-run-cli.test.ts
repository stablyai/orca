import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('lightweight Run CLI handlers', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
  })

  it('creates a Run with the resolved coordinator terminal', async () => {
    callMock.mockResolvedValue({
      result: { run: { id: 'run_1', objective: 'Coordinate work', consumer_generation: 1 } }
    })
    await ORCHESTRATION_HANDLERS['orchestration run-create']({
      flags: new Map<string, string | boolean>([
        ['objective', 'Coordinate work'],
        ['json', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith('orchestration.runCreate', {
      objective: 'Coordinate work',
      from: 'term_coord'
    })
  })

  it('reuses the same explicit binding path for run-use and run-current', async () => {
    callMock
      .mockResolvedValueOnce({ result: { run: { id: 'run_1', objective: 'Work' } } })
      .mockResolvedValueOnce({ result: { run: { id: 'run_1', objective: 'Work' } } })
    await ORCHESTRATION_HANDLERS['orchestration run-use']({
      flags: new Map([
        ['id', 'run_1'],
        ['from', 'term_coord']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    await ORCHESTRATION_HANDLERS['orchestration run-current']({
      flags: new Map([['from', 'term_coord']]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenNthCalledWith(1, 'orchestration.runUse', {
      id: 'run_1',
      from: 'term_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.runCurrent', {
      from: 'term_coord'
    })
  })

  it('passes explicit legacy takeover only when requested', async () => {
    callMock.mockResolvedValue({
      result: { run: { id: 'run_adopted', objective: 'Recovered work' } }
    })
    await ORCHESTRATION_HANDLERS['orchestration run-use']({
      flags: new Map<string, string | boolean>([
        ['id', 'run_adopted'],
        ['from', 'term_current'],
        ['takeover-legacy', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.runUse', {
      id: 'run_adopted',
      from: 'term_current',
      takeoverLegacy: true
    })
  })
})

describe('orchestration reset CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { reset: 'all' } })
  })
  const invoke = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration reset']({
      flags,
      client: { call: callMock },
      json: true
    } as never)

  it('rejects a bare reset before calling the runtime', async () => {
    await expect(invoke(new Map())).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('sends only the tasks scope for --tasks', async () => {
    await invoke(new Map([['tasks', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: undefined,
      tasks: true,
      messages: undefined
    })
  })

  it('sends only the all scope for --all', async () => {
    await invoke(new Map([['all', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: true,
      tasks: undefined,
      messages: undefined
    })
  })

  it.each([
    new Map<string, string | boolean>([
      ['tasks', true],
      ['messages', true]
    ]),
    new Map<string, string | boolean>([
      ['all', true],
      ['tasks', true]
    ])
  ])('rejects multiple reset scopes before calling the runtime', async (flags) => {
    await expect(invoke(flags)).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orchestration task-list brief output', () => {
  it('requests server-side brief and falls back client-side for older runtimes', async () => {
    callMock.mockReset().mockResolvedValue({
      result: {
        tasks: [{ id: 'task_1', spec: `First line\n${'detail '.repeat(40)}`, status: 'ready' }],
        count: 1
      }
    })
    vi.mocked(printResult).mockClear()
    await ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags: new Map([['brief', true]]),
      client: { call: callMock },
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.taskList',
      expect.objectContaining({ brief: true })
    )
    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { tasks: { spec: string; spec_truncated: boolean }[] }
    }
    expect(response.result.tasks[0].spec).toHaveLength(160)
    expect(response.result.tasks[0].spec_truncated).toBe(true)
  })

  it('passes server-abbreviated rows through untouched', async () => {
    const serverTasks = [
      { id: 'task_1', spec: 'already brief…', status: 'ready', spec_truncated: true }
    ]
    callMock.mockReset().mockResolvedValue({ result: { tasks: serverTasks, count: 1 } })
    vi.mocked(printResult).mockClear()
    await ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags: new Map([['brief', true]]),
      client: { call: callMock },
      json: true
    } as never)
    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { tasks: { spec: string; spec_truncated: boolean }[] }
    }
    expect(response.result.tasks).toBe(serverTasks)
  })
})
