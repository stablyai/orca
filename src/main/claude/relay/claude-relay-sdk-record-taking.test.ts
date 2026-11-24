import { describe, expect, it } from 'vitest'
import { RelayedProviderConsumption } from '../../provider-relay/relayed-provider-consumption'
import { claudeRelaySdkRecordTaking } from './claude-relay-sdk-record-taking'

describe('Claude relay acks through the SDK', () => {
  it('covers only lines whose messages Orca handled, and the SDK-only lines before them', () => {
    const consumption = new RelayedProviderConsumption(() => {})
    const taking = claudeRelaySdkRecordTaking(consumption.taking)
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', uuid: 'u1' }),
      JSON.stringify({ type: 'control_response', response: { request_id: 'r1' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ text: '"uuid":"no"' }] },
        uuid: 'u2'
      }),
      JSON.stringify({ type: 'result', uuid: 'u3' })
    ]
    lines.forEach((line, index) => {
      consumption.pushed(true, index + 1)
      taking.observe(`${line}\n`)
    })
    // The SDK read every line, but Orca's reader is paused: nothing may be acked.
    expect(consumption.upTo(4)).toBe(0)
    taking.handled({ type: 'system', uuid: 'u1' })
    expect(consumption.upTo(4)).toBe(1)
    // The control answer the SDK kept counts once the next handled message passes it.
    taking.handled({ type: 'assistant', uuid: 'u2' })
    expect(consumption.upTo(4)).toBe(3)
    taking.handled({ type: 'result', uuid: 'u3' })
    expect(consumption.upTo(4)).toBe(4)
  })
})
