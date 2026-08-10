import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration check mailbox selector', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { messages: [], count: 0 } })
    getTerminalHandleMock.mockReset()
    vi.mocked(printResult).mockClear()
    process.env.ORCA_TERMINAL_HANDLE = 'term_captain'
  })

  const invokeCheck = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('passes the requested mailbox to the runtime', async () => {
    await invokeCheck(new Map([['as', 'dispatch']]))

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ terminal: 'term_captain', as: 'dispatch' })
    )
  })

  it('leaves the request unchanged when no mailbox is named', async () => {
    await invokeCheck(new Map())

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ as: undefined })
    )
  })

  it('rejects an unknown mailbox before calling the runtime', async () => {
    await expect(invokeCheck(new Map([['as', 'worker']]))).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Invalid --as. Expected dispatch or coordinator.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('tells the reader which Dispatch the Run mailbox shadowed', async () => {
    callMock.mockResolvedValue({
      result: { messages: [], count: 0, shadowedDispatchId: 'ctx_cd4015c1ea15' }
    })

    await invokeCheck(new Map())

    const format = vi.mocked(printResult).mock.calls.at(-1)?.[2] as (value: unknown) => string
    expect(format({ messages: [], count: 0, shadowedDispatchId: 'ctx_cd4015c1ea15' })).toBe(
      'No messages.\nDispatch ctx_cd4015c1ea15 also holds mail for this terminal; read it with --as dispatch.'
    )
  })
})
