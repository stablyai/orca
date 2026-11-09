import { describe, expect, it } from 'vitest'
import { constantTimeEqual, splitSecrets, verifyStripeSignature } from '../src/webhook-signature'
import { signStripePayload } from './stripe-fake'

const SECRET = 'whsec_test_signature'
const BODY = '{"id":"evt_test_1","object":"event"}'
const NOW = 1_762_000_000_000
const T = NOW / 1000

describe('verifyStripeSignature', () => {
  it('accepts a header signed the way Stripe signs', async () => {
    expect(await verifyStripeSignature(BODY, signStripePayload(BODY, SECRET, T), [SECRET], NOW)).toEqual({ ok: true })
  })

  it('accepts any of several v1 signatures and either secret during rotation', async () => {
    const good = signStripePayload(BODY, 'whsec_new', T).split(',')[1]
    const header = `t=${T},v1=${'0'.repeat(64)},${good},v0=ignored`
    expect(await verifyStripeSignature(BODY, header, ['whsec_old', 'whsec_new'], NOW)).toEqual({ ok: true })
  })

  it('rejects a tampered body, a wrong secret and a replayed old timestamp', async () => {
    const header = signStripePayload(BODY, SECRET, T)
    expect(await verifyStripeSignature(`${BODY} `, header, [SECRET], NOW)).toEqual({ ok: false, reason: 'mismatch' })
    expect(await verifyStripeSignature(BODY, header, ['whsec_other'], NOW)).toEqual({ ok: false, reason: 'mismatch' })
    expect(await verifyStripeSignature(BODY, header, [SECRET], NOW + 301_000)).toEqual({ ok: false, reason: 'stale' })
  })

  it('rejects missing or malformed headers and an empty secret list', async () => {
    expect(await verifyStripeSignature(BODY, null, [SECRET], NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyStripeSignature(BODY, 't=abc,v1=zz', [SECRET], NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyStripeSignature(BODY, signStripePayload(BODY, SECRET, T), [], NOW)).toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('splits rotation secrets and compares in constant time', () => {
    expect(splitSecrets(' whsec_a , ,whsec_b')).toEqual(['whsec_a', 'whsec_b'])
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})
