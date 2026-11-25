import { describe, expect, it } from 'vitest'
import { agentShareFailedSchema } from '../../shared/telemetry/schemas/telemetry-agent-share-event-schemas'
import { agentShareCloudReason } from './agent-share-failure'

describe('agent_share_failed', () => {
  // Closed enums only: an id, a name or error text never fits the event.
  it('takes a stage and one of its own reasons, and nothing else', () => {
    expect(agentShareFailedSchema.safeParse({ stage: 'accept', reason: 'http_5xx' }).success).toBe(
      true
    )
    expect(
      agentShareFailedSchema.safeParse({ stage: 'accept', reason: 'bot_not_found' }).success
    ).toBe(false)
    expect(
      agentShareFailedSchema.safeParse({ stage: 'accept', reason: 'network', shareId: 's-1' })
        .success
    ).toBe(false)
    expect(
      agentShareFailedSchema.safeParse({ stage: 'held_send', reason: 'Host refused: alice' })
        .success
    ).toBe(false)
  })

  it('names a cloud failure by its code when it is one, else by its status', () => {
    expect(agentShareCloudReason({ status: 404, error: 'unknown_share' })).toBe('unknown_share')
    expect(agentShareCloudReason({ status: 429, error: null })).toBe('rate_limited')
    expect(agentShareCloudReason({ status: 503, error: 'overloaded' })).toBe('http_5xx')
    expect(agentShareCloudReason({ status: 400, error: 'something_new' })).toBe('http_4xx')
    expect(agentShareCloudReason({ status: null, error: null })).toBe('network')
  })
})
