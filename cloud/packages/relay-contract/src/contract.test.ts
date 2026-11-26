import { describe, expect, it } from 'vitest'
import {
  HostHelloAckSchema,
  RELAY_HOST_CAPABILITY_WIDE_CONNECTION_LISTS,
  relayHostConnectionLimit
} from './control-messages.js'
import {
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
    expect(Buffer.from(transcript).toString('base64url')).toBe(
      'AAAACHByb3RvY29sAAAAGG9yY2EtcmVsYXktaG9zdC1wcm9vZi92MQAAAAd2ZXJzaW9uAAAAAQEAAAALcmVsYXlPcmlnaW4AAAAYaHR0cHM6Ly9yZWxheS5vbm9yY2EuZGV2AAAAF3JlbGF5RXBoZW1lcmFsUHVibGljS2V5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAADmNoYWxsZW5nZU5vbmNlAAAAGAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAAAtjaGFsbGVuZ2VJZAAAAAtjaGFsbGVuZ2UtMQAAAAhpc3N1ZWRBdAAAAAgAAAGLz-VoAAAAAAlleHBpcmVzQXQAAAAIAAABi8_ljxAAAAAGdXNlcklkAAAABnVzZXItMQAAAAlwcm9maWxlSWQAAAAJcHJvZmlsZS0xAAAADm9yZ2FuaXphdGlvbklkAAAABW9yZy0xAAAAC3JlbGF5SG9zdElkAAAAEGFiY2RlZmdoaWprbG1ub3AAAAANaG9zdFB1YmxpY0tleQAAACACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAA9hc3NpZ25tZW50RXBvY2gAAAAIAAAAAAAAAAcAAAAScHJldmlvdXNHZW5lcmF0aW9uAAAACAAAAAAAAAAGAAAAD3Jlc3VtZVJlcXVlc3RlZAAAAAEB'
    )
  })

  it('grants 32 connections only to hosts whose hello-ack decoder accepts them', () => {
    expect(relayHostConnectionLimit(undefined)).toBe(8)
    expect(relayHostConnectionLimit(['pending-conn-details'])).toBe(8)
    expect(relayHostConnectionLimit(new Set([RELAY_HOST_CAPABILITY_WIDE_CONNECTION_LISTS]))).toBe(32)
    const ack = (count: number) => ({
      v: 1,
      generation: 1,
      controlResumeSecret: 'A'.repeat(43),
      leaseExpiresAt: 1,
      activeConnIds: Array.from({ length: count }, (_, index) => `conn-${index}`),
      pendingConns: []
    })
    expect(HostHelloAckSchema.safeParse(ack(32)).success).toBe(true)
    expect(HostHelloAckSchema.safeParse(ack(33)).success).toBe(false)
  })
})
