import { describe, expect, it } from 'vitest'

import { actFailure } from './connector-act'

const host = { server: null, botName: 'Release manager' }

describe('connector action read failures', () => {
  it.each([
    [
      'slack_history_scope_missing',
      /missing channel-history permission.*channels:history.*groups:history/i
    ],
    ['slack_channel_not_joined', /bot is not in that channel/i],
    ['slack_channel_not_visible', /couldn't find a channel this bot can read/i],
    ['slack_thread_not_found', /couldn't find that thread/i],
    ['slack_file_not_found', /couldn't find that file/i]
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
