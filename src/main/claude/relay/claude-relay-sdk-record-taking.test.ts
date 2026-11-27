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
    // The control answer counts as soon as every line before it does.
    taking.handled({ type: 'system', uuid: 'u1' })
    expect(consumption.upTo(4)).toBe(2)
    taking.handled({ type: 'assistant', uuid: 'u2' })
    expect(consumption.upTo(4)).toBe(3)
    taking.handled({ type: 'result', uuid: 'u3' })
    expect(consumption.upTo(4)).toBe(4)
  })

  it("takes an idle chat's control answers once the relay counts them, so they cannot pause its output", async () => {
    const consumption = new RelayedProviderConsumption(() => {})
    const taking = claudeRelaySdkRecordTaking(consumption.taking)
    for (let seq = 1; seq <= 3; seq += 1) {
      consumption.pushed(true, seq)
      taking.observe(`{"type":"control_response","response":{"request_id":"r${seq}"}}\n`)
    }
    await Promise.resolve()
    expect(consumption.upTo(3)).toBe(3)
  })

  it('never throws on a nested id it cannot read', () => {
    const consumption = new RelayedProviderConsumption(() => {})
    const taking = claudeRelaySdkRecordTaking(consumption.taking)
    consumption.pushed(true, 1)
    const nested = '{"type":"control_request","request":{"input":{"uuid":"a\\"b"}}}'
    expect(() => taking.observe(`${nested}\n`)).not.toThrow()
  })
})
