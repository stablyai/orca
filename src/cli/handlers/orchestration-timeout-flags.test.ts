// Timeout-flag validation and task-list brief output for the orchestration CLI
// handlers; payload/handle mapping lives in orchestration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callMock,
  getTerminalHandleMock,
  handlerInvoker,
  restoreTerminalIdentityEnv
} from './orchestration-handler-test-harness'

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

afterEach(restoreTerminalIdentityEnv)

describe('orchestration timeout flag validation', () => {
  const invalidTimeoutValues: [string, string | boolean][] = [
    ['missing', true],
    ['empty', ''],
    ['non-numeric', 'not-a-number'],
    ['zero', '0'],
    ['negative', '-1']
  ]

  beforeEach(() => {
    callMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeCheck = handlerInvoker(ORCHESTRATION_HANDLERS['orchestration check'])
  const invokeAsk = handlerInvoker(ORCHESTRATION_HANDLERS['orchestration ask'])

  it.each(invalidTimeoutValues)('rejects invalid check --timeout-ms: %s', async (_label, value) => {
    const flags = new Map<string, string | boolean>([
      ['wait', true],
      ['timeout-ms', value]
    ])

    await expect(invokeCheck(flags)).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('passes a parsed check timeout and peek mode into the RPC payload', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })

    await invokeCheck(
      new Map<string, string | boolean>([
        ['wait', true],
        ['peek', true],
        ['timeout-ms', '250']
      ])
    )

    // Why: --peek rides with unread:false so pre-peek runtimes fall back to
    // the non-consuming all mode instead of the destructive mark-read default.
    expect(callMock).toHaveBeenCalledWith('orchestration.check', {
      terminal: 'term_worker',
      terminalPaneKey: undefined,
      unread: false,
      peek: true,
      all: undefined,
      types: undefined,
      format: undefined,
      compatibilityCliCommand: expect.stringMatching(/^orca(?:-ide)?$/),
      run: undefined,
      ack: undefined,
      wait: true,
      timeoutMs: 250
    })
  })

  it('filters already-read rows from a peek response for pre-peek runtimes', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        messages: [
          { id: 'msg_old', from_handle: 'a', subject: 'seen', read: 1 },
          { id: 'msg_new', from_handle: 'a', subject: 'fresh', read: 0 }
        ],
        count: 2,
        formatted: 'banners built from all rows'
      }
    })
    vi.mocked(printResult).mockClear()

    await invokeCheck(new Map<string, string | boolean>([['peek', true]]))

    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { messages: { id: string }[]; count: number; formatted?: string }
    }
    expect(response.result.messages.map((m) => m.id)).toEqual(['msg_new'])
    expect(response.result.count).toBe(1)
    // Why: the pre-peek runtime built `formatted` from all rows, including
    // the read one the filter just removed.
    expect(response.result.formatted).toBeUndefined()
  })

  it('rejects combined read modes before calling the runtime', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockClear()

    await expect(
      invokeCheck(
        new Map<string, string | boolean>([
          ['unread', true],
          ['peek', true]
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('read mode')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('warns when a pre-peek runtime returned a full 100-row page', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `msg_${i}`,
      from_handle: 'a',
      subject: `s${i}`,
      read: i === 0 ? 0 : 1
    }))
    callMock.mockResolvedValue({ result: { messages: rows, count: 100 } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await invokeCheck(new Map<string, string | boolean>([['peek', true]]))

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('newest 100 messages'))
    errorSpy.mockRestore()
  })

  it('fails --peek --wait against a runtime that returned only read rows', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        messages: [{ id: 'msg_old', from_handle: 'a', subject: 'seen', read: 1 }],
        count: 1
      }
    })

    await expect(
      invokeCheck(
        new Map<string, string | boolean>([
          ['peek', true],
          ['wait', true]
        ])
      )
    ).rejects.toMatchObject({ code: 'peek_wait_unsupported' })
  })

  it.each(invalidTimeoutValues)('rejects invalid ask --timeout-ms: %s', async (_label, value) => {
    const flags = new Map<string, string | boolean>([
      ['to', 'term_coord'],
      ['question', 'Proceed?'],
      ['timeout-ms', value]
    ])

    await expect(invokeAsk(flags)).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('uses the parsed ask timeout for both runtime wait and client timeout', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        answer: 'yes',
        messageId: 'msg_1',
        threadId: 'thread_1',
        timedOut: false
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await invokeAsk(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['question', 'Proceed?'],
        ['timeout-ms', '123']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.ask',
      {
        to: 'term_coord',
        run: undefined,
        question: 'Proceed?',
        resume: undefined,
        options: undefined,
        timeoutMs: 123,
        from: 'term_worker',
        compatibilityCliCommand: expect.stringMatching(/^orca(?:-ide)?$/),
        compatibilityWindowsCommand: undefined
      },
      { timeoutMs: 5_123, orchestrationCapability: undefined }
    )
  })

  it('passes an ask resume without creating a new question payload', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        answer: 'yes',
        messageId: 'msg_question',
        threadId: 'msg_question',
        timedOut: false
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await invokeAsk(new Map<string, string | boolean>([['resume', 'msg_question']]))

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.ask',
      {
        to: undefined,
        run: undefined,
        question: undefined,
        resume: 'msg_question',
        options: undefined,
        timeoutMs: undefined,
        from: 'term_worker',
        compatibilityCliCommand: expect.stringMatching(/^orca(?:-ide)?$/),
        compatibilityWindowsCommand: undefined
      },
      { timeoutMs: 605_000, orchestrationCapability: undefined }
    )
  })

  it('rejects ambiguous ask create/resume input before RPC', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    await expect(
      invokeAsk(
        new Map<string, string | boolean>([
          ['question', 'new'],
          ['resume', 'msg_old']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orchestration task-list brief output', () => {
  it('requests server-side brief and falls back client-side for older runtimes', async () => {
    callMock.mockReset().mockResolvedValue({
      result: {
        // No spec_truncated field — the pre-brief-runtime signature.
        tasks: [{ id: 'task_1', spec: `First line\n${'detail '.repeat(40)}`, status: 'ready' }],
        count: 1
      }
    })
    vi.mocked(printResult).mockClear()

    await handlerInvoker(ORCHESTRATION_HANDLERS['orchestration task-list'])(
      new Map([['brief', true]])
    )

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

    await handlerInvoker(ORCHESTRATION_HANDLERS['orchestration task-list'])(
      new Map([['brief', true]])
    )

    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { tasks: { spec: string; spec_truncated: boolean }[] }
    }
    // Why: re-abbreviating a server-truncated spec would flip spec_truncated
    // back to false (the truncated text fits the cap).
    expect(response.result.tasks).toBe(serverTasks)
  })
})
