import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { encodePairingOffer, parsePairingCode as sharedParse } from '../../../src/shared/pairing'
import { parsePairingCode as mobileParse } from './pairing'

// Why: pairing.ts is a hand-kept mirror of src/shared/pairing.ts. This locks
// the accept/reject sets together so a change to one that quietly widens or
// narrows the other fails here instead of on a user's phone.

const url = encodePairingOffer({
  v: 2,
  endpoint: 'ws://10.0.0.12:6768',
  deviceToken: 'd567a164c76349b574ef7245b9b4139e06d26fdb2b88815c',
  publicKeyB64: '8zI4ewziHt2TSeA34T6GxDm1yHu45btRMiw6mYL2J0A=',
  scope: 'mobile'
})
const code = url.slice('orca://pair?code='.length)

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const INPUTS = [
  '',
  '   ',
  'garbage',
  'not a pairing code',
  url,
  code,
  ` ${url} `,
  `orca://pair#${code}`,
  'orca://pair',
  'orca://pair?code=',
  `orca://pairing?code=${code}`,
  `orca://pair-extra?code=${code}`,
  `orca://pair/?code=${code}`,
  `orca://pair/extra?code=${code}`,
  `https://example.com/pair#${code}`,
  `orca://pair?code=${code}#other`,
  `orca://pair?other=1&code=${code}`,
  code.slice(0, 40),
  `${code}!!!`,
  'orca://',
  encode({ v: 1, endpoint: 'ws://x:1', deviceToken: 't', publicKeyB64: 'k' }),
  encode({ v: 3, endpoint: 'ws://x:1', deviceToken: 't', publicKeyB64: 'k' }),
  encode({ v: 2 }),
  encode({ v: 2, endpoint: '', deviceToken: 't', publicKeyB64: 'k' }),
  encode({ v: '2', endpoint: 'ws://x:1', deviceToken: 't', publicKeyB64: 'k' }),
  encode({ endpoint: 'ws://x:1', deviceToken: 't', publicKeyB64: 'k' }),
  encode([1, 2, 3]),
  encode('a string'),
  encode(null)
]

describe('shared/mobile pairing parity', () => {
  it('accepts and rejects exactly the same inputs', () => {
    const disagreements = INPUTS.filter(
      (input) => (sharedParse(input) !== null) !== (mobileParse(input) !== null)
    )

    expect(disagreements).toEqual([])
  })

  it('agrees on the decoded offer, not just on accepting it', () => {
    expect(mobileParse(url)).toEqual(sharedParse(url))
    expect(mobileParse(code)).toEqual(sharedParse(code))
  })

  // Why: pre-dates this parity test — mobile matches the scheme and host
  // case-insensitively because QR alphanumeric mode encodes uppercase, while
  // the shared copy's URL.hostname comparison is case-sensitive. Pinned here so
  // the gap is visible rather than forgotten.
  it('documents the one known divergence: uppercase scheme and host', () => {
    const uppercase = `ORCA://PAIR?code=${code}`

    expect(mobileParse(uppercase)).not.toBeNull()
    expect(sharedParse(uppercase)).toBeNull()
  })
})
