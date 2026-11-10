import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { EntitlementClient, StartDecision, UsageAnswer, UsageSegment } from '../src/entitlements'
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
    usage: [] as UsageSegment[]
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
    ...overrides
  }
  // No live github.com from tests: repos count as public unless a test says otherwise.
  const deps: Deps = { provider: vercel, entitlements, now: clock, publicRepoCheck: async () => true, ...extraDeps }

  async function token(sub: string, org?: string, purpose = 'sandbox', extra: Record<string, string> = {}) {
    const iat = Math.floor(now / 1000)
    return new SignJWT({ sub, ...(org ? { org } : {}), purpose, ...extra })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('https://login.onorca.dev')
      .setAudience('orca-sandbox')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 300)
      .sign(privateKey)
  }

  async function send(request: Request): Promise<Response> {
    return handleRequest(request, env, deps)
  }

  async function call(method: string, path: string, init: { body?: unknown; as?: string; bearer?: string } = {}) {
    const bearer = init.bearer ?? (await token(init.as ?? 'alice'))
    const request = new Request(`https://sandbox.test${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
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
