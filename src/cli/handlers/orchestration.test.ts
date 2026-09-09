import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY
function lifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'

afterEach(() => {
  getTerminalHandleMock.mockReset()
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
  if (originalPaneKey === undefined) {
    delete process.env.ORCA_PANE_KEY
  } else {
    process.env.ORCA_PANE_KEY = originalPaneKey
  }
})

describe('orchestration send structured payload flags', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { lifecycle: { action: 'completed' } } })
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeSend = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('serializes common worker payload fields as JSON', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['outcome', 'succeeded'],
        ['files-modified', 'src/a.ts, src/b.ts'],
        ['report-path', 'reports/done.md']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'done',
      body: undefined,
      type: 'worker_done',
      priority: undefined,
      threadId: undefined,
      payload: JSON.stringify({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        outcome: 'succeeded',
        filesModified: ['src/a.ts', 'src/b.ts'],
        reportPath: 'reports/done.md'
      }),
      waitForLifecycleSettlement: true,
      devMode: false
    })
  })

  it('forwards multiline message bodies without normalization', async () => {
    const body = 'paragraph one line one\nparagraph one line two\n\nparagraph two'

    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to', 'term_coord'],
        ['subject', 'multiline'],
        ['body', body]
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.send', expect.objectContaining({ body }))
  })

  it('carries Dispatch authority in the RPC envelope instead of message params', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['subject', 'alive'],
        ['type', 'heartbeat'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret'],
        ['retry-request', '33333333-3333-4333-8333-333333333333']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.not.objectContaining({ dispatchCapability: expect.anything() }),
      {
        orchestrationCapability: 'dcap_secret',
        orchestrationRequestId: '33333333-3333-4333-8333-333333333333'
      }
    )
  })

  it('rejects mixing raw payload with structured payload flags', async () => {
    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['from', 'term_worker'],
          ['to', 'term_coord'],
          ['subject', 'done'],
          ['payload', '{"taskId":"task_1"}'],
          ['task-id', 'task_1']
        ])
      )
    ).rejects.toThrow(/structured payload/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects worker_done group sends before resolving a sender handle', async () => {
    getTerminalHandleMock.mockRejectedValue(new Error('sender resolution should not run'))

    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['to', '@all'],
          ['subject', 'done'],
          ['type', 'worker_done']
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: lifecycleGroupRecipientError('worker_done')
    })

    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects heartbeat group sends before resolving a sender handle', async () => {
    getTerminalHandleMock.mockRejectedValue(new Error('sender resolution should not run'))

    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['to', '@idle'],
          ['subject', 'alive'],
          ['type', 'heartbeat']
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: lifecycleGroupRecipientError('heartbeat')
    })

    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('continues to allow worker_done to a concrete terminal handle', async () => {
    await invokeSend(
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'done',
      body: undefined,
      type: 'worker_done',
      priority: undefined,
      threadId: undefined,
      payload: JSON.stringify({ outcome: 'succeeded' }),
      waitForLifecycleSettlement: true,
      devMode: false
    })
  })

  it('sends lifecycle messages from ORCA_TERMINAL_HANDLE without a liveness probe', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'

    await invokeSend(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ])
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('orchestration.send', {
      from: 'term_worker_env',
      to: 'term_coord',
      subject: 'done',
      body: undefined,
      type: 'worker_done',
      priority: undefined,
      threadId: undefined,
      payload: JSON.stringify({ outcome: 'succeeded' }),
      waitForLifecycleSettlement: true,
      devMode: false
    })
  })

  it.each(['worker_done', 'heartbeat'] as const)(
    'never probes or remints a %s sender even when a pane key is set',
    async (type) => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'
      process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'

      await invokeSend(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'update'],
          ['type', type],
          ...(type === 'worker_done' ? ([['outcome', 'succeeded']] as const) : [])
        ])
      )

      // Why: pre-payload-authority runtimes only complete a worker_done whose
      // sender equals the recorded (equally stale) assignee handle, and
      // coordinator replies route to the sender row the worker's env-handle
      // `check` actually reads — so lifecycle sends must stay env-verbatim.
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith(
        'orchestration.send',
        expect.objectContaining({ from: 'term_worker_env' })
      )
    }
  )

  it('passes ORCA_PANE_KEY as the sender pane identity', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker_env'
    process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'

    await invokeSend(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['subject', 'done'],
        ['type', 'worker_done'],
        ['outcome', 'succeeded']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      expect.objectContaining({ senderPaneKey: 'tab_worker:leaf_worker' })
    )
  })

  it('reports sender resolution failure instead of raw no_active_terminal', async () => {
    getTerminalHandleMock.mockRejectedValue(
      new RuntimeClientError('no_active_terminal', 'no_active_terminal')
    )

    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'done'],
          ['type', 'worker_done'],
          ['outcome', 'succeeded']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('Pass --from')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each(['worker_done', 'heartbeat'] as const)(
    'does not resolve an identity-less %s sender from the active terminal',
    async (type) => {
      getTerminalHandleMock.mockResolvedValue('term_active_coordinator')

      await expect(
        invokeSend(
          new Map<string, string | boolean>([
            ['to', 'term_coord'],
            ['subject', 'update'],
            ['type', type],
            ...(type === 'worker_done' ? ([['outcome', 'succeeded']] as const) : [])
          ])
        )
      ).rejects.toMatchObject({ code: 'no_active_sender_terminal' })

      expect(getTerminalHandleMock).not.toHaveBeenCalled()
      expect(callMock).not.toHaveBeenCalled()
    }
  )
})

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

  const invokeCheck = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  const invokeAsk = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration ask']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

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

  it('envelopes ask --json through the shared result printer', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    const response = {
      id: 'req_ask',
      ok: true,
      result: { answer: 'yes', messageId: 'msg_1', threadId: 'thread_1', timedOut: false },
      _meta: { runtimeId: 'runtime_1' }
    }
    callMock.mockResolvedValue(response)
    vi.mocked(printResult).mockClear()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await invokeAsk(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['question', 'Proceed?']
      ])
    )

    expect(printResult).toHaveBeenCalledWith(response, true, expect.any(Function))
    expect(logSpy).not.toHaveBeenCalled()
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
