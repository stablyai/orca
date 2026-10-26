import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { CONNECTOR_REPLY_UNAVAILABLE } from '../../shared/rpc-contract/connector-params'
import { CONNECTOR_HANDLERS, formatReply } from './connector'

const call = vi.fn()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply handler calls only client.call.
const client = { call } as unknown as RuntimeClient

function context(): HandlerContext {
  return { client, cwd: process.cwd(), flags: new Map([['text', 'done']]), json: true, rawArgs: [] }
}

beforeEach(() => {
  vi.stubEnv('ORCA_PANE_KEY', 'tab:1')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  call.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orca connector reply', () => {
  it('sends the calling pane and the text, and says where it went', async () => {
    call.mockResolvedValue({ result: { status: 'posted', messageId: '1793.1' } })
    await CONNECTOR_HANDLERS['connector reply'](context())
    expect(call).toHaveBeenCalledWith(
      'connector.reply',
      { paneKey: 'tab:1', replyId: expect.any(String), text: 'done' },
      { timeoutMs: 180_000 }
    )
    expect(formatReply({ status: 'posted' })).toBe('Posted to the thread.')
    expect(formatReply({ status: 'queued' })).toBe('Sent; Orca Cloud will post it to the thread.')
  })

  it('takes the pane from the scrub-safe alias when Claude scrubbed ORCA_PANE_KEY', async () => {
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv('ORCA_AGENT_PANE', 'tab:2')
    call.mockResolvedValue({ result: { status: 'queued' } })
    await CONNECTOR_HANDLERS['connector reply'](context())
    expect(call.mock.calls[0]?.[1]).toMatchObject({ paneKey: 'tab:2' })
  })

  it.each([
    'not_a_cloud_conversation',
    'connector_not_connected',
    'connectors_disabled',
    'method_not_found'
  ])('says replies are not available from this host when the host answers %s', async (code) => {
    call.mockRejectedValue(new RuntimeClientError(code, code))
    await expect(CONNECTOR_HANDLERS['connector reply'](context())).rejects.toMatchObject({
      code: 'not_a_cloud_conversation',
      message: CONNECTOR_REPLY_UNAVAILABLE
    })
  })

  it('passes a refusal through, and refuses outside an agent pane', async () => {
    call.mockRejectedValue(new RuntimeClientError('no_current_turn', 'no_current_turn'))
    await expect(CONNECTOR_HANDLERS['connector reply'](context())).rejects.toMatchObject({
      code: 'no_current_turn'
    })
    expect(call).toHaveBeenCalledTimes(1)

    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.stubEnv('ORCA_AGENT_PANE', '')
    await expect(CONNECTOR_HANDLERS['connector reply'](context())).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})
