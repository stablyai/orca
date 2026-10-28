import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySlackSignature } from './slack-signature.js'

describe('verifySlackSignature', () => {
  const sign = (secret: string, timestamp: string, body: string) =>
    `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
  const check = (signature: string, timestamp = '1800000000', nowMs = 1_800_000_000_000) =>
    verifySlackSignature({ signingSecret: 's', timestamp, signature, rawBody: '{"a":1}', nowMs })

  it('accepts Slack’s v0 signature within five minutes', () => {
    expect(check(sign('s', '1800000000', '{"a":1}'))).toBe(true)
    expect(check(sign('s', '1800000000', '{"a":1}'), '1800000000', 1_800_000_300_000)).toBe(true)
  })

  it('refuses another secret, another body, a stale timestamp, or a malformed one', () => {
    expect(check(sign('t', '1800000000', '{"a":1}'))).toBe(false)
    expect(check(sign('s', '1800000000', '{"a":2}'))).toBe(false)
    expect(check(sign('s', '1800000000', '{"a":1}'), '1800000000', 1_800_000_301_000)).toBe(false)
    expect(check(sign('s', '1e9', '{"a":1}'), '1e9')).toBe(false)
  })
})
