import { describe, expect, it } from 'vitest'
import { parseResultsTo } from './automation-bot-create'

describe('--results-to channel:', () => {
  it('keeps a pasted link whole, so the host looks it up in its own workspace', () => {
    expect(parseResultsTo('channel:https://app.slack.com/client/T2/C08NLB8LXCP')).toEqual({
      channel: 'https://app.slack.com/client/T2/C08NLB8LXCP'
    })
  })

  it('keeps an id in its one spelling', () => {
    expect(parseResultsTo('channel:c08nlb8lxcp')).toEqual({ channel: 'C08NLB8LXCP' })
  })
})
