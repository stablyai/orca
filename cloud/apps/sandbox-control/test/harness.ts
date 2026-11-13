import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { AUTH_IAT_BACKDATE_MS } from '../src/member-changes'
import { BillingUnavailableError, type EntitlementClient, type PlanFeatures, type StartDecision, type UsageAnswer, type UsageSegment } from '../src/entitlements'
import type { Env } from '../src/env'
import { handleRequest, type Deps } from '../src/index'
import { reconcile } from '../src/reconcile'
import { createFakeD1 } from './d1-fake'
import { createFakeVercel } from './fake-vercel'

export const GOLDEN = 'snap_golden'

export async function createHarness(overrides: Partial<Env> = {}, extraDeps: Partial<Deps> = {}) {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }
  const { db, raw } = createFakeD1()
  let now = 1_800_000_000_000
  const clock = () => now
  const vercel = createFakeVercel(clock)
  const billing = {
    decision: { allow: true, reason: null, suspendRunning: false } as StartDecision,
    usageAnswer: { canStartSandbox: true, reason: null, suspendRunning: false } as UsageAnswer,
    suspensions: [] as string[],
    down: false,
    checks: [] as { accountId: string; runningSandboxes: number }[],
    requests: [] as Parameters<EntitlementClient['checkStart']>[0][],
    usage: [] as UsageSegment[],
    /** Plan features billing reports (the audit log's Enterprise gate): off unless a test turns one on. */
    features: { auditLog: false } as PlanFeatures
  }
  const entitlements: EntitlementClient = {
    async checkStart(request) {
      billing.checks.push({ accountId: request.accountId, runningSandboxes: request.runningSandboxes })
      billing.requests.push(request)
      return billing.decision
    },
    async reportUsage(segment) {
      if (billing.down) {
        throw new Error('billing down')
      }
      billing.usage.push(segment)
      return billing.usageAnswer
    },
    async listSuspensions() {
      return billing.suspensions
    },
    async features() {
      if (billing.down) {
        throw new BillingUnavailableError('billing down')
      }
      return billing.features
    }
  }
  const env: Env = {
    SANDBOX_DB: db,
    SANDBOX_ENV: 'test',
    SANDBOX_JWKS: JSON.stringify({ keys: [jwk] }),
    SANDBOX_JWT_AUDIENCE: 'orca-sandbox',
    SANDBOX_AUTH_ISSUER: 'https://login.onorca.dev',
    GOLDEN_SNAPSHOT_ID: GOLDEN,
    VERCEL_TEAM_ID: 'team_orca',
    VERCEL_PROJECT_ID: 'prj_orca',
    // Off unless a test turns it on (auto-environments.test.ts): it starts builds behind creates.
    AUTO_ENVIRONMENTS: 'off',
    ...overrides
  }
  // No live github.com from tests: repos count as public unless a test says otherwise.
  // Hand-offs ask auth whether the new owner is in the team; tests answer yes unless they say otherwise
  // (pass `teamMembership: undefined` to get the real check, which refuses when unconfigured).
  const deps: Deps = { provider: vercel, entitlements, now: clock, publicRepoCheck: async () => true, teamMembership: async () => ({ member: true }), transferNotifier: async () => ({ emailed: false, mode: 'log', reason: 'logged' }), ...extraDeps }

  async function token(sub: string, org?: string, purpose = 'sandbox', extra: Record<string, string> = {}) {
    // Like Orca auth (service-tokens.ts): iat backdated 30 s for clock skew, exp 5 min from minting.
    const minted = Math.floor(now / 1000)
    const iat = minted - AUTH_IAT_BACKDATE_MS / 1000
    return new SignJWT({ sub, ...(org ? { org } : {}), purpose, ...extra })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('https://login.onorca.dev')
      .setAudience('orca-sandbox')
      .setIssuedAt(iat)
      .setExpirationTime(minted + 300)
      .sign(privateKey)
  }

  async function send(request: Request): Promise<Response> {
    return handleRequest(request, env, deps)
  }

  async function call(
    method: string,
    path: string,
    init: { body?: unknown; as?: string; bearer?: string; headers?: Record<string, string> } = {}
  ) {
    const bearer = init.bearer ?? (await token(init.as ?? 'alice'))
    const request = new Request(`https://sandbox.test${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    })
    const response = await handleRequest(request, env, deps)
    return { status: response.status, body: (await response.json()) as any }
  }

  return {
    env,
    deps,
    raw,
    vercel,
    billing,
    call,
    send,
    token,
    advance(ms: number) {
      now += ms
    },
    now: clock,
    reconcile: () =>
      reconcile({
        db,
        provider: vercel,
        entitlements,
        github: extraDeps.github,
        now: clock,
        config: { environment: 'test', goldenSnapshotId: GOLDEN, defaultRegion: 'iad1' }
      })
  }
}
