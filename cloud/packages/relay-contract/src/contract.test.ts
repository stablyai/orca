import { describe, expect, it } from 'vitest'
import { RELAY_CLOSE_CODE } from './close-codes.js'
import {
  AuthRefreshSchema,
  DrainSchema,
  HostChallengeSchema,
  HostDataAuthSchema,
  HostHelloAckSchema,
  HostHelloSchema
} from './control-messages.js'
import {
  DeviceCredentialInstallSchema,
  DeviceResumeConfirmSchema,
  RelayAuthSchema,
  RelayHelloSchema
} from './credential-messages.js'
import {
  AssignmentRequestSchema,
  AssignmentResponseSchema,
  isTrustedNewerMove,
  RelayMovedSchema,
  ResolveRequestSchema
} from './director-messages.js'
import { RELAY_PROTOCOL_LIMITS } from './protocol-limits.js'
import { RelayRegionCatalogResponseSchema } from './relay-regions.js'
import {
  buildHostChallengePlaintext,
  buildHostProofMacInput,
  buildHostProofTranscript
} from './host-proof-transcript.js'
import { ConfirmableResumeTupleSchema } from './resume-confirmation-contract.js'
import {
  canAdvanceSplice,
  mayAcknowledgeClient,
  SPLICE_STATE
} from './splice-state-machine.js'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'
const NONCE = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const KEY_B64 = Buffer.alloc(32, 1).toString('base64')

describe('relay protocol contract', () => {
  it('locks close codes and fixed normative limits', () => {
    expect(RELAY_CLOSE_CODE).toEqual({
      BAD_OUTER_CREDENTIAL: 4401,
      HOST_OFFLINE: 4404,
      PEER_DROPPED: 4408,
      WRONG_CELL: 4409,
      LIMIT_EXCEEDED: 4429,
      DRAINING: 4503
    })
    expect(RELAY_PROTOCOL_LIMITS).toMatchObject({
      firstFrameDeadlineMs: 2_000,
      maxHttpBodyBytes: 4_096,
      maxFrameBytes: 8 * 1024 * 1024,
      maxConnectionsPerHost: 8,
      idleTimeoutMs: 600_000,
      inviteMaxAttempts: 5,
      inviteReservationLeaseMs: 15_000,
      hostAttachDeadlineMs: 10_000,
      resumeConfirmationDeadlineMs: 30_000
    })
  })

  it('strictly validates host registration and continuity fields', () => {
    const hello = {
      v: 1,
      relayHostId: 'abcdefghijklmnop',
      assignmentEpoch: 7,
      hostPublicKeyB64: KEY_B64,
      appVersion: '1.2.3'
    }
    expect(HostHelloSchema.safeParse(hello).success).toBe(true)
    expect(HostHelloSchema.safeParse({ ...hello, userId: 'injected' }).success).toBe(false)
    expect(
      HostHelloAckSchema.safeParse({
        v: 1,
        generation: 8,
        controlResumeSecret: TOKEN,
        leaseExpiresAt: 1_800_000_000_000,
        activeConnIds: [],
        pendingConns: []
      }).success
    ).toBe(true)
  })

  it('locks bounded director assignment and resume-only resolve payloads', () => {
    const assignment = { v: 1, relayHostId: 'abcdefghijklmnop' }
    expect(AssignmentRequestSchema.safeParse(assignment).success).toBe(true)
    expect(
      AssignmentRequestSchema.safeParse({ ...assignment, preferredRegion: 'asia-east2' }).success
    ).toBe(true)
    expect(
      AssignmentRequestSchema.safeParse({ ...assignment, preferredRegion: 'europe-west1' }).success
    ).toBe(false)
    expect(AssignmentRequestSchema.safeParse({ ...assignment, relayJwt: 'url-secret' }).success).toBe(
      false
    )
    expect(
      AssignmentResponseSchema.safeParse({
        v: 1,
        cellUrl: 'https://relay-c1.onorca.dev',
        assignmentEpoch: 3,
        lease: 'signed-lease'
      }).success
    ).toBe(true)
    expect(
      ResolveRequestSchema.safeParse({
        v: 1,
        relayHostId: 'abcdefghijklmnop',
        resumeToken: TOKEN
      }).success
    ).toBe(true)
  })

  it('accepts only unique regions with unique canonical HTTPS probe origins', () => {
    const catalog = {
      v: 1,
      regions: [
        {
          region: 'us-central1',
          probeOrigins: ['https://relay-c1.example.test', 'https://relay-c2.example.test']
        },
        { region: 'asia-east2', probeOrigins: ['https://relay-c27.example.test'] }
      ]
    }
    expect(RelayRegionCatalogResponseSchema.safeParse(catalog).success).toBe(true)
    expect(
      RelayRegionCatalogResponseSchema.safeParse({
        ...catalog,
        regions: [catalog.regions[0], { ...catalog.regions[0] }]
      }).success
    ).toBe(false)
    expect(
      RelayRegionCatalogResponseSchema.safeParse({
        ...catalog,
        regions: [
          catalog.regions[0],
          { region: 'asia-east2', probeOrigins: ['https://relay-c1.example.test'] }
        ]
      }).success
    ).toBe(false)
    for (const origin of [
      'http://relay-c1.example.test',
      'https://relay-c1.example.test/',
      'https://relay-c1.example.test/health',
      'https://relay-c1.example.test?probe=1'
    ]) {
      expect(
        RelayRegionCatalogResponseSchema.safeParse({
          v: 1,
          regions: [{ region: 'us-central1', probeOrigins: [origin] }]
        }).success
      ).toBe(false)
    }
  })

  it('accepts moves only from the configured director at a strictly newer epoch', () => {
    const move = RelayMovedSchema.parse({
      v: 1,
      cellUrl: 'https://relay-c2.onorca.dev',
      assignmentEpoch: 4
    })
    const base = {
      configuredDirectorOrigin: 'https://relay.onorca.dev',
      currentAssignmentEpoch: 3,
      move
    }
    expect(isTrustedNewerMove({ ...base, sourceOrigin: 'https://relay.onorca.dev' })).toBe(true)
    expect(isTrustedNewerMove({ ...base, sourceOrigin: move.cellUrl })).toBe(false)
    expect(
      isTrustedNewerMove({
        ...base,
        sourceOrigin: 'https://relay.onorca.dev',
        currentAssignmentEpoch: 4
      })
    ).toBe(false)
  })

  it('bounds challenge material and fixes director-only drain recovery', () => {
    expect(
      HostChallengeSchema.safeParse({
        challengeId: 'challenge-1',
        relayEphemeralPublicKeyB64: KEY_B64,
        nonceB64: NONCE,
        ciphertextB64: KEY_B64,
        expiresAt: 1_800_000_000_000
      }).success
    ).toBe(true)
    expect(DrainSchema.safeParse({ graceMs: 0, recovery: 'resolve-director' }).success).toBe(true)
    expect(DrainSchema.safeParse({ graceMs: 0, recovery: 'follow-server-url' }).success).toBe(false)
    expect(AuthRefreshSchema.safeParse({ relayJwt: 'jwt', identity: 'injected' }).success).toBe(false)
  })

  it('strictly binds one-shot host data tickets to a control generation', () => {
    expect(HostDataAuthSchema.safeParse({ v: 1, connTicket: TOKEN, generation: 3 }).success).toBe(
      true
    )
    expect(
      HostDataAuthSchema.safeParse({
        v: 1,
        connTicket: TOKEN,
        generation: 3,
        relayDeviceId: 'injected'
      }).success
    ).toBe(false)
  })

  it('cannot acknowledge a splice before forwarding handlers exist', () => {
    expect(
      canAdvanceSplice(SPLICE_STATE.PRE_AUTH_ADMITTED, SPLICE_STATE.CREDENTIAL_LEASE_RESERVED)
    ).toBe(true)
    expect(canAdvanceSplice(SPLICE_STATE.PRE_AUTH_ADMITTED, SPLICE_STATE.SPLICED)).toBe(false)
    expect(mayAcknowledgeClient(SPLICE_STATE.HOST_ATTACHED, false)).toBe(false)
    expect(mayAcknowledgeClient(SPLICE_STATE.HOST_ATTACHED, true)).toBe(true)
  })

  it('locks the immutable server-owned resume tuple shape', () => {
    const tuple = {
      basisConnId: 'conn-1',
      owningControlGeneration: 4,
      relayDeviceId: 'device-1',
      acceptedCredentialVersion: 2,
      acceptedAs: 'current',
      confirmDeadline: 1_800_000_000_000
    }
    expect(ConfirmableResumeTupleSchema.safeParse(tuple).success).toBe(true)
    expect(ConfirmableResumeTupleSchema.safeParse({ ...tuple, userId: 'caller-value' }).success).toBe(
      false
    )
  })

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
    expect(challenge.byteLength).toBe(transcript.byteLength + 65)
    expect(proofInput.byteLength).toBe(transcript.byteLength + 29)
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

  it('accepts only the bounded first-frame credential shape', () => {
    expect(RelayAuthSchema.parse({ v: 1, mode: 'connect', credential: TOKEN })).toEqual({
      v: 1,
      mode: 'connect',
      credential: TOKEN
    })
    expect(
      RelayAuthSchema.safeParse({ v: 1, mode: 'connect', credential: TOKEN, extra: true }).success
    ).toBe(false)
  })

  it('makes install authorization modes mutually exclusive', () => {
    const base = {
      v: 1,
      reqId: 'req-1',
      relayDeviceId: 'device-1',
      newResumeTokenHash: TOKEN
    }
    expect(
      DeviceCredentialInstallSchema.safeParse({
        ...base,
        authorization: { mode: 'relay-basis', basisConnId: 'conn-1' }
      }).success
    ).toBe(true)
    expect(
      DeviceCredentialInstallSchema.safeParse({
        ...base,
        authorization: {
          mode: 'relay-basis',
          basisConnId: 'conn-1',
          directAuthId: 'injected'
        }
      }).success
    ).toBe(false)
  })

  it('does not let invite attach observations impersonate resume state', () => {
    expect(
      RelayHelloSchema.safeParse({
        ok: true,
        credentialKind: 'invite',
        leaseExpiresAt: 1_800_000_000_000
      }).success
    ).toBe(true)
    expect(
      RelayHelloSchema.safeParse({
        ok: true,
        credentialKind: 'invite',
        leaseExpiresAt: 1_800_000_000_000,
        acceptedCredentialVersion: 7,
        acceptedAs: 'current',
        resumeExpiresAt: 1_800_000_000_000
      }).success
    ).toBe(false)
  })

  it('rejects caller-supplied device and credential metadata on resume confirmation', () => {
    const confirmation = { v: 1, reqId: 'req-1', basisConnId: 'conn-1' }
    expect(DeviceResumeConfirmSchema.safeParse(confirmation).success).toBe(true)
    expect(
      DeviceResumeConfirmSchema.safeParse({
        ...confirmation,
        relayDeviceId: 'injected',
        acceptedCredentialVersion: 99
      }).success
    ).toBe(false)
  })
})
