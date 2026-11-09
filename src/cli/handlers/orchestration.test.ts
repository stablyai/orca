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

import { printResult } from '../format'
import { okFixture } from '../test-fixtures'
import { ORCHESTRATION_ASK_RETURNS_AT_ONCE_RUNTIME_CAPABILITY } from '../../shared/orchestration/orchestration-runtime-capabilities'

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
