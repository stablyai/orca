import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

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

beforeEach(() => {
  callMock.mockReset()
  getTerminalHandleMock.mockReset()
  vi.mocked(printResult).mockReset()
  delete process.env.ORCA_TERMINAL_HANDLE
  delete process.env.ORCA_PANE_KEY
})

afterEach(() => {
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
  vi.restoreAllMocks()
})

describe('orchestration timeout flag validation', () => {
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

    expect(callMock).toHaveBeenCalledWith('orchestration.check', {
      terminal: 'term_worker',
      unread: false,
      peek: true,
      all: undefined,
      types: undefined,
      inject: undefined,
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

  it.each([String(2_147_483_647), String(Number.MAX_SAFE_INTEGER)])(
    'clamps a safe ask timeout %s before adding transport headroom',
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
        expect.objectContaining({ timeoutMs: 1_800_000 }),
        { timeoutMs: 1_805_000 }
      )
    }
  )

  it.each(['+1000', '1000.0', '1e3', '0x3e8'])(
    'preserves CLI-compatible exact integer timeout syntax %s',
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
        expect.objectContaining({ timeoutMs: 1_000 }),
        { timeoutMs: 6_000 }
      )
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
        question: 'Proceed?',
        options: undefined,
        timeoutMs: 123,
        from: 'term_worker'
      },
      { timeoutMs: 5_123 }
    )
  })
})
