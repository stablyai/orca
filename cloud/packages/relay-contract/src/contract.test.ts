import { describe, expect, it } from 'vitest'
import {
  buildHostChallengePlaintext,
  buildHostProofMacInput,
  buildHostProofTranscript
} from './host-proof-transcript.js'

describe('relay protocol contract', () => {
  it('locks the complete host key-possession transcript', () => {
    const transcript = buildHostProofTranscript({
      relayOrigin: 'https://relay.onorca.dev',
      relayEphemeralPublicKey: new Uint8Array(32).fill(1),
      challengeNonce: new Uint8Array(24).fill(4),
      challengeId: 'challenge-1',
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_010_000,
      userId: 'user-1',
      profileId: 'profile-1',
      organizationId: 'org-1',
      relayHostId: 'abcdefghijklmnop',
      hostPublicKey: new Uint8Array(32).fill(2),
      assignmentEpoch: 7,
      previousGeneration: 6,
      resumeRequested: true
    })
    const challenge = buildHostChallengePlaintext(transcript, new Uint8Array(32).fill(3))
    const proofInput = buildHostProofMacInput(transcript)

    expect(Buffer.from(transcript).toString('base64url')).toBe(
      'AAAACHByb3RvY29sAAAAGG9yY2EtcmVsYXktaG9zdC1wcm9vZi92MQAAAAd2ZXJzaW9uAAAAAQEAAAALcmVsYXlPcmlnaW4AAAAYaHR0cHM6Ly9yZWxheS5vbm9yY2EuZGV2AAAAF3JlbGF5RXBoZW1lcmFsUHVibGljS2V5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAADmNoYWxsZW5nZU5vbmNlAAAAGAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAAAtjaGFsbGVuZ2VJZAAAAAtjaGFsbGVuZ2UtMQAAAAhpc3N1ZWRBdAAAAAgAAAGLz-VoAAAAAAlleHBpcmVzQXQAAAAIAAABi8_ljxAAAAAGdXNlcklkAAAABnVzZXItMQAAAAlwcm9maWxlSWQAAAAJcHJvZmlsZS0xAAAADm9yZ2FuaXphdGlvbklkAAAABW9yZy0xAAAAC3JlbGF5SG9zdElkAAAAEGFiY2RlZmdoaWprbG1ub3AAAAANaG9zdFB1YmxpY0tleQAAACACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAA9hc3NpZ25tZW50RXBvY2gAAAAIAAAAAAAAAAcAAAAScHJldmlvdXNHZW5lcmF0aW9uAAAACAAAAAAAAAAGAAAAD3Jlc3VtZVJlcXVlc3RlZAAAAAEB'
    )
    const length = Buffer.alloc(4)
    length.writeUInt32BE(transcript.byteLength)
    expect(Buffer.from(challenge)).toEqual(
      Buffer.concat([
        Buffer.from('orca-relay-host-challenge/v1\0'),
        length,
        Buffer.from(transcript),
        Buffer.alloc(32, 3)
      ])
    )
    expect(Buffer.from(proofInput)).toEqual(
      Buffer.concat([Buffer.from('orca-relay-host-proof/v1\0ack\0'), Buffer.from(transcript)])
    )
    expect(() => buildHostChallengePlaintext(transcript, new Uint8Array(31))).toThrow(
      'challengeSecret must be 32 bytes'
    )
    expect(() =>
      buildHostProofTranscript({
        relayOrigin: 'https://relay.onorca.dev',
        relayEphemeralPublicKey: new Uint8Array(32),
        challengeNonce: new Uint8Array(32),
        challengeId: 'challenge-1',
        issuedAt: 1,
        expiresAt: 2,
        userId: 'user-1',
        profileId: 'profile-1',
        organizationId: 'org-1',
        relayHostId: 'abcdefghijklmnop',
        hostPublicKey: new Uint8Array(32),
        assignmentEpoch: 1,
        resumeRequested: false
      })
    ).toThrow('challengeNonce must be 24 bytes')
  })
})
