import { describe, expect, it } from 'vitest'
import {
  buildPushHostChallengePlaintext,
  buildPushHostProofMacInput,
  buildPushHostProofTranscript
} from './push-host-proof-transcript.js'

const transcriptInput = {
  gatewayOrigin: 'https://push.onorca.dev',
  gatewayEphemeralPublicKey: new Uint8Array(32).fill(7),
  challengeNonce: new Uint8Array(24).fill(9),
  challengeId: 'challenge-1',
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_010_000,
  hostFingerprint: 'abcdefghijklmnop',
  hostPublicKey: new Uint8Array(32).fill(4)
}

describe('push host proof transcript', () => {
  it('is deterministic and binds the challenge identity', () => {
    const first = buildPushHostProofTranscript(transcriptInput)
    const second = buildPushHostProofTranscript({ ...transcriptInput })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const different = buildPushHostProofTranscript({
      ...transcriptInput,
      challengeId: 'challenge-2'
    })
    expect(Buffer.from(first).equals(Buffer.from(different))).toBe(false)
  })

  it('encodes exactly the ten specified fields in order', () => {
    const transcript = buildPushHostProofTranscript(transcriptInput)
    const view = new DataView(transcript.buffer, transcript.byteOffset, transcript.byteLength)
    const fields: [string, Buffer][] = []
    let offset = 0
    while (offset < transcript.byteLength) {
      const nameLength = view.getUint32(offset, false)
      offset += 4
      const name = Buffer.from(transcript.slice(offset, offset + nameLength)).toString('utf8')
      offset += nameLength
      const valueLength = view.getUint32(offset, false)
      offset += 4
      fields.push([name, Buffer.from(transcript.slice(offset, offset + valueLength))])
      offset += valueLength
    }
    expect(fields).toEqual([
      ['protocol', Buffer.from('orca-push-host-proof/v1')],
      ['version', Buffer.from([1])],
      ['gatewayOrigin', Buffer.from('https://push.onorca.dev')],
      ['gatewayEphemeralPublicKey', Buffer.alloc(32, 7)],
      ['challengeNonce', Buffer.alloc(24, 9)],
      ['challengeId', Buffer.from('challenge-1')],
      ['issuedAt', Buffer.from('0000018bcfe56800', 'hex')],
      ['expiresAt', Buffer.from('0000018bcfe58f10', 'hex')],
      ['hostFingerprint', Buffer.from('abcdefghijklmnop')],
      ['hostPublicKey', Buffer.alloc(32, 4)]
    ])
    expect(offset).toBe(transcript.byteLength)
  })

  it('rejects mis-sized key material', () => {
    expect(() =>
      buildPushHostProofTranscript({
        ...transcriptInput,
        gatewayEphemeralPublicKey: new Uint8Array(31)
      })
    ).toThrow('gatewayEphemeralPublicKey must be 32 bytes')
    expect(() =>
      buildPushHostProofTranscript({
        ...transcriptInput,
        hostPublicKey: new Uint8Array(31)
      })
    ).toThrow('hostPublicKey must be 32 bytes')
    expect(() =>
      buildPushHostProofTranscript({ ...transcriptInput, challengeNonce: new Uint8Array(23) })
    ).toThrow('challengeNonce must be 24 bytes')
  })

  it('frames the challenge plaintext as domain, length, transcript, secret', () => {
    const transcript = buildPushHostProofTranscript(transcriptInput)
    const secret = new Uint8Array(32).fill(11)
    const plaintext = buildPushHostChallengePlaintext(transcript, secret)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(transcript.byteLength)
    expect(Buffer.from(plaintext)).toEqual(
      Buffer.concat([
        Buffer.from('orca-push-host-challenge/v1\0'),
        length,
        Buffer.from(transcript),
        Buffer.alloc(32, 11)
      ])
    )
    expect(() => buildPushHostChallengePlaintext(transcript, new Uint8Array(16))).toThrow(
      'challengeSecret must be 32 bytes'
    )
  })

  it('separates the ack mac input from the challenge domain', () => {
    const transcript = buildPushHostProofTranscript(transcriptInput)
    const macInput = buildPushHostProofMacInput(transcript)
    expect(Buffer.from(macInput)).toEqual(
      Buffer.concat([Buffer.from('orca-push-host-proof/v1\0ack\0'), Buffer.from(transcript)])
    )
  })
})
