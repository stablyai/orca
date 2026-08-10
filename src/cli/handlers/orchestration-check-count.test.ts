import { beforeEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn(() => 'term_coord') }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

beforeEach(() => {
  callMock.mockReset()
  vi.mocked(printResult).mockClear()
})

async function runCheck(flags: [string, string][], result?: unknown): Promise<void> {
  if (result !== undefined) {
    callMock.mockResolvedValueOnce({ result })
  }
  await ORCHESTRATION_HANDLERS['orchestration check']({
    flags: new Map(flags),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
}

function lastPrinted(): { result: Record<string, unknown>; line: string } {
  const call = vi.mocked(printResult).mock.calls.at(-1)
  const printed = call?.[0] as { result: Record<string, unknown> }
  const format = call?.[2] as (value: unknown) => string
  return { result: printed.result, line: format(printed.result) }
}

it('prints the count a runtime that supports --count returns', async () => {
  await runCheck(
    [
      ['terminal', 'term_coord'],
      ['count', '']
    ],
    { messages: [], count: 3, countByDeliveryClass: { interrupt: 1, tool: 0, turn: 2 } }
  )

  expect(callMock.mock.calls[0][1]).toMatchObject({ count: true, peek: true, unread: false })
  expect(lastPrinted().line).toBe('3 messages (1 interrupt, 2 turn).')
})

it('counts locally when the runtime predates --count and answers the peek instead', async () => {
  await runCheck(
    [
      ['terminal', 'term_coord'],
      ['count', '']
    ],
    {
      count: 2,
      messages: [
        { id: 'msg_1', from_handle: 'term_a', subject: 'a', delivery_class: 'interrupt', read: 0 },
        { id: 'msg_2', from_handle: 'term_a', subject: 'b', read: 0 },
        { id: 'msg_3', from_handle: 'term_a', subject: 'c', read: 1 }
      ]
    }
  )

  const { result, line } = lastPrinted()
  expect(result.count).toBe(2)
  expect(result.countByDeliveryClass).toEqual({ interrupt: 1, tool: 0, turn: 1 })
  expect(result.messages).toEqual([])
  expect(line).toBe('2 messages (1 interrupt, 1 turn).')
})

it('says so plainly when nothing is waiting', async () => {
  await runCheck(
    [
      ['terminal', 'term_coord'],
      ['count', '']
    ],
    { messages: [], count: 0, countByDeliveryClass: { interrupt: 0, tool: 0, turn: 0 } }
  )

  expect(lastPrinted().line).toBe('No messages.')
})

it('refuses to combine a presence probe with a wait or an acknowledgment', async () => {
  await expect(
    runCheck([
      ['terminal', 'term_coord'],
      ['count', ''],
      ['wait', '']
    ])
  ).rejects.toThrow('--count returns only a mailbox count')
  await expect(
    runCheck([
      ['terminal', 'term_coord'],
      ['count', ''],
      ['ack', 'delivery_1']
    ])
  ).rejects.toThrow('--count returns only a mailbox count')
  expect(callMock).not.toHaveBeenCalled()
})

it('refuses a delivery class the contract does not define, before any round trip', async () => {
  await expect(
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags: new Map([
        ['from', 'term_coord'],
        ['to', 'term_worker'],
        ['subject', 'hi'],
        ['delivery-class', 'immediate']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)
  ).rejects.toThrow('--delivery-class must be one of interrupt, tool, turn.')
  expect(callMock).not.toHaveBeenCalled()
})

it('passes the requested delivery class through to the runtime', async () => {
  callMock.mockResolvedValueOnce({ result: { message: { id: 'msg_1' } } })

  await ORCHESTRATION_HANDLERS['orchestration send']({
    flags: new Map([
      ['from', 'term_coord'],
      ['to', 'term_worker'],
      ['subject', 'hi'],
      ['delivery-class', 'interrupt']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)

  expect(callMock.mock.calls[0][1]).toMatchObject({ deliveryClass: 'interrupt' })
})
