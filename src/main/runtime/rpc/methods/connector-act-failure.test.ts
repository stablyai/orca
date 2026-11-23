import { describe, expect, it } from 'vitest'

import { actFailure } from './connector-act'
import { callAct } from '../../../../cli/slack/slack'

const host = { server: null, botName: 'Release manager' }

describe('connector action read failures', () => {
  it.each([
    ['missing_scope', /missing channel-history permission.*channels:history.*groups:history/i],
    ['not_in_channel', /bot is not in that channel/i],
    ['channel_not_found', /couldn't find a channel this bot can read/i],
    ['thread_not_found', /couldn't find that thread/i]
  ])('explains Slack %s refusals', (error, message) => {
    expect(actFailure('read', 'slack:T1:C1:1.0', { status: 403, error }, host)).toMatchObject({
      code: 'connector_refused',
      message: expect.stringMatching(message)
    })
  })

  it('keeps a non-Slack read refusal unchanged', () => {
    expect(
      actFailure('read', 'linear:org:issue', { status: 403, error: 'forbidden' }, host)
    ).toMatchObject({
      code: 'connector_refused',
      message: 'Orca Cloud refused it (forbidden).'
    })
  })

  it('explains a Slack refusal returned by the action service', async () => {
    const client = {
      call: async () => ({
        ok: true,
        result: { ok: false, refusal: 'missing_scope', message: 'Slack API rejected the request.' }
      })
    } as Parameters<typeof callAct>[0]

    await expect(
      callAct(client, { sessionId: 'session-1', verb: 'read', args: {} })
    ).rejects.toMatchObject({ message: expect.stringContaining('channels:history') })
  })
})
