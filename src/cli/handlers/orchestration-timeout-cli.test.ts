import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
const originalCliCommand = process.env.ORCA_CLI_COMMAND

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

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
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    if (originalCliCommand === undefined) {
      delete process.env.ORCA_CLI_COMMAND
    } else {
      process.env.ORCA_CLI_COMMAND = originalCliCommand
    }
    vi.restoreAllMocks()
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

  const invokePlainAsk = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration ask']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

  it.each(invalidTimeoutValues)('rejects invalid check --timeout-ms: %s', async (_label, value) => {
    await expect(
      invokeCheck(
        new Map<string, string | boolean>([
          ['wait', true],
          ['timeout-ms', value]
        ])
      )
    ).rejects.toThrow(/--timeout-ms/)
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
    // Why: unread:false makes pre-peek runtimes fall back to non-consuming all mode.
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
    expect(response.result.messages.map((message) => message.id)).toEqual(['msg_new'])
    expect(response.result.count).toBe(1)
    expect(response.result.formatted).toBeUndefined()
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
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: `msg_${index}`,
      from_handle: 'a',
      subject: `s${index}`,
      read: index === 0 ? 0 : 1
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
    await expect(
      invokeAsk(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['question', 'Proceed?'],
          ['timeout-ms', value]
        ])
      )
    ).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('uses the parsed ask timeout for both runtime wait and client timeout', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: { answer: 'yes', messageId: 'msg_1', threadId: 'thread_1', timedOut: false }
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

    await invokePlainAsk(
      new Map<string, string | boolean>([
        ['question', 'Proceed?'],
        ['dispatch-capability', 'dcap_secret'],
        ['timeout-ms', '30000']
      ])
    )

    expect(errorSpy).toHaveBeenCalledWith(
      'ask timeout after 30000ms; question is still pending (messageId: msg_question). ' +
        'Resume waiting; do not ask again:\n' +
        'orca-dev orchestration ask --from term_worker --dispatch-capability dcap_secret ' +
        '--resume msg_question --timeout-ms 30000'
    )
    expect(process.exitCode).toBe(1)
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
