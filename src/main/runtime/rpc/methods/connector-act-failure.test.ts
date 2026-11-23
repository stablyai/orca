import { describe, expect, it } from 'vitest'

import { actFailure } from './connector-act'

const host = { server: null, botName: 'Release manager' }

describe('connector action read failures', () => {
  it.each([
    ['missing_scope', /missing channel-history permission.*channels:history.*groups:history/i],
    ['needs_reapproval', /missing channel-history permission/i],
    ['not_in_place', /bot is not in that channel/i],
    ['not_found', /couldn't find a channel this bot can read/i],
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
})
