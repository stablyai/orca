import { describe, expect, it } from 'vitest'
import { connectorActionIntoThread } from './connector-action-into-thread'

const conversation = { source: 'slack', externalId: 'T1:C1:1.0:U0BOT' }

describe('connectorActionIntoThread', () => {
  it('counts a reply, and a post or file into the chat’s own conversation', () => {
    expect(connectorActionIntoThread({ verb: 'reply', args: {}, conversation: null })).toBe(true)
    expect(connectorActionIntoThread({ verb: 'post', args: {}, conversation })).toBe(true)
    expect(connectorActionIntoThread({ verb: 'attach', args: {}, conversation })).toBe(true)
  })

  it('never counts a post elsewhere, a staged file or a post scheduled for later', () => {
    expect(connectorActionIntoThread({ verb: 'post', args: {}, ref: '#ops', conversation })).toBe(
      false
    )
    expect(connectorActionIntoThread({ verb: 'post', args: {}, conversation: null })).toBe(false)
    expect(connectorActionIntoThread({ verb: 'attach', args: { stage: true }, conversation })).toBe(
      false
    )
    expect(connectorActionIntoThread({ verb: 'reply', args: { upload: 'u1' }, conversation })).toBe(
      false
    )
    expect(
      connectorActionIntoThread({
        verb: 'post',
        args: { postAt: '2026-11-29T00:00:00Z' },
        conversation
      })
    ).toBe(false)
  })
})
