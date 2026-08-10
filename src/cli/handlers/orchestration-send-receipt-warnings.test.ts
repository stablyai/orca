import { expect, it, vi } from 'vitest'

const callMock = vi.fn()
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'

async function send(result: unknown): Promise<string> {
  callMock.mockReset().mockResolvedValueOnce({ result })
  await ORCHESTRATION_HANDLERS['orchestration send']({
    flags: new Map([
      ['from', 'term_worker'],
      ['to', 'term_coord'],
      ['subject', 'ping']
    ]),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: false
  } as never)
  const call = vi.mocked(printResult).mock.calls.at(-1)
  const format = call?.[2] as (value: unknown) => string
  return format(result)
}

it('prints the recipients a send could not reach', async () => {
  const line = await send({
    message: { id: 'msg_1' },
    warnings: [
      {
        code: 'recipient_reads_other_mailbox',
        recipient: 'term_coord',
        message: 'term_coord reads run:run_1, and that mailbox never returns handle mail.'
      }
    ]
  })

  expect(line).toBe(
    'Sent msg_1\nWarning: term_coord reads run:run_1, and that mailbox never returns handle mail.'
  )
})

it('prints one warning line per unreachable fan-out recipient', async () => {
  const line = await send({
    messages: [{ id: 'msg_1' }, { id: 'msg_2' }],
    recipients: 2,
    warnings: [
      { code: 'recipient_reads_other_mailbox', recipient: 'term_coord', message: 'coord warning' },
      { code: 'no_live_terminal', recipient: 'term_worker', message: 'worker warning' }
    ]
  })

  expect(line).toBe(
    'Sent 2 messages to 2 recipients\nWarning: coord warning\nWarning: worker warning'
  )
})

it('shows a partial fan-out as a smaller recipient count plus the skipped recipient', async () => {
  const line = await send({
    messages: [{ id: 'msg_1' }],
    recipients: 1,
    warnings: [
      {
        code: 'recipient_unreachable',
        recipient: 'term_orphan',
        message: 'No live terminal holds term_orphan, so no message was created for it.'
      }
    ]
  })

  expect(line).toBe(
    'Sent 1 messages to 1 recipients\nWarning: No live terminal holds term_orphan, so no message was created for it.'
  )
})

it('leaves a clean receipt unchanged', async () => {
  expect(await send({ message: { id: 'msg_1' } })).toBe('Sent msg_1')
})
