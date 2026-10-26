// An in-process Orca Cloud connector speaking the real wire shapes, with a real sealed-challenge handshake.
import { randomBytes } from 'node:crypto'
import {
  CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
  CONNECTOR_PATHS
} from '../../shared/connector-cloud-contract'
import { deriveRelayHostId } from '../runtime/mobile-cloud-relay/relay-http-client'
import { buildPushChallengeFixture } from '../runtime/push/push-host-challenge-fixtures'

export type FakeSignInAnswer =
  | { status: 'pending' | 'slow_down' | 'denied' | 'expired'; interval?: number }
  | { status: 'authorized'; email: string; hostId?: string }

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

export class FakeConnectorCloud {
  readonly origin = 'https://connector.test'
  readonly requests: { path: string; body: unknown; token: string | null }[] = []
  /** Answers each sign-in poll in turn; the last one repeats. */
  signInAnswers: FakeSignInAnswer[] = [{ status: 'pending' }]
  /** Forces a status on every request to these paths, e.g. 404 from an older cloud. */
  readonly forced = new Map<string, Reply>()
  online = true
  /** Requests never answer, as on a stalled network. */
  hang = false
  readonly linked = new Map<string, string>()
  /** The key the last sign-in start offered. */
  signInPublicKeyB64: string | null = null
  private polls = 0
  private readonly proofs = new Map<string, { proof: string; hostId: string }>()
  private readonly sessions = new Map<string, string>()

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (!this.online) {
      throw new TypeError('fetch failed')
    }
    if (this.hang) {
      return new Promise<never>(() => {})
    }
    const url = new URL(String(input))
    const path = url.pathname
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    const auth = new Headers(init?.headers).get('authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    this.requests.push({ path, body, token })
    const reply = this.forced.get(path) ?? this.route(path, body, token)
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers }
    })
  }

  requestsTo(path: string): { body: unknown; token: string | null }[] {
    return this.requests.filter((request) => request.path === path)
  }

  /** The host id a session token was issued to, for routes added by later suites. */
  sessionHost(token: string | null): string | null {
    return token ? (this.sessions.get(token) ?? null) : null
  }

  protected route(path: string, body: unknown, token: string | null): Reply {
    const fields = isRecord(body) ? body : {}
    switch (path) {
      case CONNECTOR_PATHS.signInStart:
        this.signInPublicKeyB64 = String(fields.hostPublicKeyB64)
        this.polls = 0
        return {
          status: 201,
          body: {
            deviceCode: randomBytes(32).toString('base64url'),
            userCode: 'ABCD-EFGH',
            verificationUri: `${this.origin}/host-login`,
            expiresAt: Date.now() + 10 * 60_000,
            interval: 1
          }
        }
      case CONNECTOR_PATHS.signInPoll:
        return this.answerSignInPoll()
      case CONNECTOR_PATHS.hostChallenge:
        return this.issueChallenge(String(fields.hostPublicKeyB64))
      case CONNECTOR_PATHS.hostSession:
        return this.issueSession(String(fields.challengeId), String(fields.proofB64))
      case CONNECTOR_PATHS.signOut: {
        const hostId = this.sessionHost(token)
        if (!hostId) {
          return { status: 401, body: { error: 'session_expired' } }
        }
        this.linked.delete(hostId)
        return { status: 204 }
      }
      default:
        return { status: 404, body: { error: 'not_found' } }
    }
  }

  private answerSignInPoll(): Reply {
    const answer = this.signInAnswers[Math.min(this.polls++, this.signInAnswers.length - 1)]
    if (answer.status !== 'authorized') {
      return { status: 200, body: { status: answer.status, interval: answer.interval ?? 1 } }
    }
    const hostId =
      answer.hostId ?? deriveRelayHostId(Buffer.from(this.signInPublicKeyB64 ?? '', 'base64'))
    this.linked.set(hostId, answer.email)
    return {
      status: 200,
      body: { status: 'authorized', interval: 1, hostId, account: { email: answer.email } }
    }
  }

  private issueChallenge(hostPublicKeyB64: string): Reply {
    const publicKey = Uint8Array.from(Buffer.from(hostPublicKeyB64, 'base64'))
    const hostId = deriveRelayHostId(publicKey)
    if (!this.linked.has(hostId)) {
      return { status: 403, body: { error: 'host_not_linked' } }
    }
    const challengeId = `challenge-${this.proofs.size + 1}`
    const { challenge, proof } = buildPushChallengeFixture({
      hostKeypair: { publicKey, secretKey: new Uint8Array(32), publicKeyB64: hostPublicKeyB64 },
      gatewayOrigin: this.origin,
      hostFingerprint: hostId,
      issuedAt: Date.now(),
      challengeId,
      domains: {
        transcript: CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN,
        challengePlaintext: CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN
      }
    })
    this.proofs.set(challengeId, { proof, hostId })
    return { status: 200, body: challenge }
  }

  private issueSession(challengeId: string, proofB64: string): Reply {
    const expected = this.proofs.get(challengeId)
    this.proofs.delete(challengeId)
    if (!expected || expected.proof !== proofB64) {
      return { status: 403, body: { error: 'proof_rejected' } }
    }
    if (!this.linked.has(expected.hostId)) {
      return { status: 403, body: { error: 'host_not_linked' } }
    }
    const sessionToken = randomBytes(32).toString('base64url')
    this.sessions.set(sessionToken, expected.hostId)
    return {
      status: 200,
      body: { sessionToken, expiresAt: Date.now() + 60 * 60_000, hostId: expected.hostId }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
