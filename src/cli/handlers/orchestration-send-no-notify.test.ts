import { expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime/types'

vi.mock('../format', () => ({ printResult: vi.fn() }))
import { parseArgs } from '../args'
import { ORCHESTRATION_SEND_HANDLER } from './orchestration/message-send-handler'

const flags = new Map<string, string | boolean>([
  ['from', 'term_sender'],
  ['to', 'term_recipient'],
  ['subject', 'external'],
  ['no-notify', true]
])

function rpcSuccess(result: unknown): RuntimeRpcSuccess<unknown> {
  return {
    id: 'req_test',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime_test' }
  }
}

function sendInvocation(testFlags: Map<string, string | boolean>) {
  const client = new RuntimeClient('/tmp/orca-no-notify-cli', 1_000, null, null)
  const call = vi.spyOn(client, 'call')
  const context: HandlerContext = {
    flags: testFlags,
    client,
    cwd: '/tmp',
    json: true
  }
  return { context, call }
}

it('rejects an old server before issuing the send mutation', async () => {
  const { context, call } = sendInvocation(flags)
  call.mockResolvedValue(rpcSuccess({ capabilities: [] }))
  await expect(ORCHESTRATION_SEND_HANDLER['orchestration send'](context)).rejects.toMatchObject({
    code: 'incompatible_runtime'
  })
  expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
})

it('sends notify=false only after server capability verification', async () => {
  const { context, call } = sendInvocation(flags)
  call.mockImplementation(async (method) =>
    method === 'status.get'
      ? rpcSuccess({ capabilities: ['orchestration.message-notify.v1'] })
      : rpcSuccess({ message: { id: 'msg_one' } })
  )
  await ORCHESTRATION_SEND_HANDLER['orchestration send'](context)
  expect(call).toHaveBeenCalledWith(
    'orchestration.send',
    expect.objectContaining({ notify: false })
  )
})

it('leaves a default send compatible with older runtimes', async () => {
  const defaults = new Map(flags)
  defaults.delete('no-notify')
  const { context, call } = sendInvocation(defaults)
  call.mockResolvedValue(rpcSuccess({ message: { id: 'msg_default' } }))
  await ORCHESTRATION_SEND_HANDLER['orchestration send'](context)
  expect(call.mock.calls.map(([method]) => method)).toEqual(['orchestration.send'])
  expect(call.mock.calls[0]?.[1]).not.toHaveProperty('notify')
})

it('rejects a malformed opt-out rather than silently enabling notification', async () => {
  const invalid = new Map(flags).set('no-notify', 'maybe')
  const { context, call } = sendInvocation(invalid)
  call.mockRejectedValue(new Error('send should not reach the runtime'))
  await expect(ORCHESTRATION_SEND_HANDLER['orchestration send'](context)).rejects.toMatchObject({
    code: 'invalid_argument'
  })
  expect(call).not.toHaveBeenCalled()
})

it('parses the boolean flag before the command without consuming its name', () => {
  const parsed = parseArgs(['--no-notify', 'orchestration', 'send', '--subject', 'external'])
  expect(parsed.commandPath).toEqual(['orchestration', 'send'])
  expect(parsed.flags.get('no-notify')).toBe(true)
})
