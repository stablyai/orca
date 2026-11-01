import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
// Reuse one mutation identity when retrying worker_done after runtime_unavailable.
const WORKER_DONE_REQUEST = { orchestrationRequestId: expect.any(String) }
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalExitCode = process.exitCode
function lifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'
import { okFixture } from '../test-fixtures'
import { ORCHESTRATION_ASK_RETURNS_AT_ONCE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

beforeEach(() => {
  callMock.mockReset()
  getTerminalHandleMock.mockReset()
  vi.mocked(printResult).mockReset()
  vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined)
  vi.stubEnv('ORCA_PANE_KEY', undefined)
  vi.stubEnv('ORCA_STRUCTURED_SESSION', undefined)
  vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  vi.stubEnv('ORCA_CLI_COMMAND', undefined)
  vi.stubEnv('ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER', undefined)
  vi.stubEnv('ORCA_DEV_CLI_INVOCATION', undefined)
  vi.stubEnv('ORCA_USER_DATA_PATH', undefined)
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orchestration send structured payload flags', () => {
  beforeEach(() => {
    callMock.mockResolvedValue(
      okFixture('req_send', { message: { id: 'msg_sent' }, lifecycle: { action: 'completed' } })
    )
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
        ['files-modified', ' src/a.ts, ,src/b.ts, '],
        ['phase', 'verification'],
        ['report-path', 'reports/done.md']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      {
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
          reportPath: 'reports/done.md',
          phase: 'verification'
        }),
        waitForLifecycleSettlement: true,
        devMode: false
      },
      WORKER_DONE_REQUEST
    )
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

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      {
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
      },
      WORKER_DONE_REQUEST
    )
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
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.send',
      {
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
      },
      WORKER_DONE_REQUEST
    )
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

      // Older hosts match lifecycle senders to stale assignee handles, so preserve the env spelling.
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith(
        'orchestration.send',
        expect.objectContaining({ from: 'term_worker_env' }),
        ...(type === 'worker_done' ? [WORKER_DONE_REQUEST] : [])
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
      expect.objectContaining({ senderPaneKey: 'tab_worker:leaf_worker' }),
      WORKER_DONE_REQUEST
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
          ['subject', 'update']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('Pass --from')
    })
    expect(getTerminalHandleMock).toHaveBeenCalledOnce()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses a structured session without naming a handle it could pass', async () => {
    process.env.ORCA_STRUCTURED_SESSION = '1'
    getTerminalHandleMock.mockResolvedValue('term_sibling_pane')

    // --from bypasses this guard and could select another pane; never recommend it as recovery.
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
      message: expect.not.stringContaining('Pass --from')
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
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
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['rounded fractional', '9007199254740991.1'],
    ['unsafe integer', String(Number.MAX_SAFE_INTEGER + 1)]
  ]

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

  const invokePlainAsk = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration ask']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

  it.each(invalidTimeoutValues)('rejects invalid check --timeout-ms: %s', async (_label, value) => {
    const flags = new Map<string, string | boolean>([
      ['wait', true],
      ['timeout-ms', value]
    ])

    await expect(invokeCheck(flags)).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
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

    // unread:false keeps --peek non-consuming when older runtimes ignore the peek field.
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
    await invokeCheck(
      new Map<string, string | boolean>([
        ['peek', true],
        ['full', true]
      ])
    )

    expect(printResult).toHaveBeenCalledOnce()
    const response = vi.mocked(printResult).mock.calls[0]?.[0]
    expect(response).toHaveProperty('result.messages', [
      { id: 'msg_new', from_handle: 'a', subject: 'fresh', read: 0 }
    ])
    expect(response).toHaveProperty('result.count', 1)
    // Older formatted output includes read rows removed by the client filter.
    expect(response).toHaveProperty('result.formatted', undefined)
  })

  it('rejects combined read modes before calling the runtime', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
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
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it.each(['1', '1800000'])(
    'accepts an ask timeout %s within the supported range with transport headroom',
    async (rawTimeout) => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
      callMock.mockResolvedValue({
        result: { answer: 'yes', messageId: 'msg_1', threadId: 'thread_1', timedOut: false }
      })
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await invokeAsk(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['question', 'Proceed?'],
          ['timeout-ms', rawTimeout]
        ])
      )

      expect(callMock).toHaveBeenCalledWith(
        'orchestration.ask',
        expect.objectContaining({ timeoutMs: Number(rawTimeout) }),
        { timeoutMs: Number(rawTimeout) + 5_000 }
      )
    }
  )

  it.each(['1800001', String(Number.MAX_SAFE_INTEGER)])(
    'rejects an oversized ask timeout %s before resolving identity or creating a question',
    async (timeoutMs) => {
      process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
      callMock.mockResolvedValue({
        result: { answer: 'yes', messageId: 'msg_1', threadId: 'thread_1', timedOut: false }
      })
      await expect(
        invokeAsk(
          new Map<string, string | boolean>([
            ['question', 'Proceed?'],
            ['timeout-ms', timeoutMs]
          ])
        )
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringMatching(/--timeout-ms.*1800000.*30 minutes/)
      })
      expect(callMock).not.toHaveBeenCalled()
      expect(getTerminalHandleMock).not.toHaveBeenCalled()
    }
  )

  it('keeps an omitted ask timeout out of the payload while using default headroom', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: { answer: 'yes', messageId: 'msg_1', threadId: 'thread_1', timedOut: false }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await invokeAsk(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['question', 'Proceed?']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.ask',
      expect.objectContaining({ timeoutMs: undefined }),
      { timeoutMs: 605_000 }
    )
  })

  it('prints the pending message ID and exact capability-bound resume command on timeout', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    process.env.ORCA_CLI_COMMAND = 'orca-dev'
    callMock.mockResolvedValue({
      result: {
        answer: null,
        messageId: 'msg_question',
        threadId: 'thread_question',
        timedOut: true,
        timeoutMs: 30_000
      }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await invokePlainAsk(
      new Map<string, string | boolean>([
        ['question', 'Proceed?'],
        ['dispatch-capability', 'dcap_secret'],
        ['timeout-ms', '30000']
      ])
    )

    expect(logSpy).toHaveBeenCalledWith(
      'Question msg_question is still pending after 30000ms.\n' +
        'Next: Resume waiting; do not ask again: ' +
        'orca-dev orchestration ask --from term_worker --dispatch-capability dcap_secret ' +
        '--resume msg_question --timeout-ms 30000'
    )
    expect(errorSpy).toHaveBeenCalledWith(
      'error: ask_timeout: ask timeout after 30000ms; question msg_question is still pending. ' +
        'Resume waiting; do not ask again: ' +
        'orca-dev orchestration ask --from term_worker --dispatch-capability dcap_secret ' +
        '--resume msg_question --timeout-ms 30000'
    )
    expect(process.exitCode).toBe(1)
  })

  it('asks without waiting only when the Orca it talks to advertises it', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    const askedWith = async (capabilities: string[]) => {
      callMock.mockReset()
      callMock.mockImplementation(async (method: string) =>
        method === 'status.get'
          ? { result: { capabilities } }
          : { result: { answer: null, messageId: 'msg_q', threadId: 'msg_q', timedOut: false } }
      )
      await invokeAsk(new Map<string, string | boolean>([['question', 'Proceed?']]))
      return callMock.mock.calls.find(([method]) => method === 'orchestration.ask')?.[1]
    }

    expect(await askedWith([ORCHESTRATION_ASK_RETURNS_AT_ONCE_RUNTIME_CAPABILITY])).toMatchObject({
      wait: false
    })
    expect(await askedWith([])).not.toHaveProperty('wait')
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await invokeAsk(
      new Map<string, string | boolean>([
        ['to', 'term_coord'],
        ['question', 'Proceed?'],
        ['full', true]
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
