// ORG-TOKEN-STALE: sandbox tokens are minted for the team the desktop shows, verified against the
// token's org claim, dropped on team/role changes, and re-minted once when the control plane refuses.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { OrcaProfileCloudSummary } from '../../shared/orca-profiles'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { linkOrcaProfileToCloud } from '../orca-profiles/cloud-auth/profile-cloud-index'
import { noteOrcaCloudMemberships } from '../orca-profiles/cloud-token-epoch'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getHostedSandboxConfig } from './hosted-sandbox-config'

vi.mock('../orca-profiles/cloud-session/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: async (
    _config: unknown,
    _active: unknown,
    _userDataPath: string,
    operation: (session: { accessToken: string }) => Promise<unknown>
  ) => ({ status: 'ok', value: await operation({ accessToken: 'session-access' }) })
}))

const state = { dir: '' }
installFakeAppEnvironment({ getPath: () => state.dir })

const MINT_URL = 'http://127.0.0.1:9/v1/desktop/auth/sandbox-token'
const CONTROL_PLANE = 'https://sandbox.cloud.test'

/** Unsigned token-shaped test value; only the claims matter to the desktop. */
function fakeToken(org: string | null, serial: number): string {
  const claims = { sub: 'user-a', ...(org ? { org } : {}), purpose: 'sandbox', serial }
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
}

function tokenOrg(authorization: string | null): string | null {
  const payload = authorization?.replace(/^Bearer /, '').split('.')[1] ?? ''
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { org?: string }
  return claims.org ?? null
}

function cloud(activeOrgId?: string, activeOrgName?: string): OrcaProfileCloudSummary {
  return {
    cloudProfileId: 'cp-user-a',
    userId: 'user-a',
    email: 'user-a@example.test',
    ...(activeOrgId ? { activeOrgId } : {}),
    ...(activeOrgName ? { activeOrgName } : {}),
    linkedAt: 1
  }
}

type MintCall = { body: string }

/**
 * Fake auth + control plane. `issue` decides the org claim of each minted token from the requested
 * org; the control plane answers via `controlPlane`.
 */
function harness(options: {
  issue?: (requested: string | null | undefined, call: number) => string | null
  mintStatus?: (body: string, call: number) => number
  controlPlane?: (request: { headers: Headers; call: number }) => Response
}) {
  const mints: MintCall[] = []
  const controlCalls: Headers[] = []
  let gate: Promise<void> | null = null
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === MINT_URL) {
      const body = String(init?.body ?? '')
      mints.push({ body })
      const call = mints.length
      const status = options.mintStatus?.(body, call) ?? 200
      if (status !== 200) {
        return Response.json({ error: 'invalid_request' }, { status })
      }
      const requested = (JSON.parse(body) as { orgId?: string | null }).orgId
      // Auth decides the team when asked, even if its answer arrives after a switch.
      const org = options.issue ? options.issue(requested, call) : (requested ?? null)
      const pending = gate
      if (pending) {
        await pending
      }
      return Response.json({ sandboxToken: fakeToken(org, call), expiresAt: Date.now() + 300_000 })
    }
    const headers = new Headers(init?.headers)
    controlCalls.push(headers)
    return (
      options.controlPlane?.({ headers, call: controlCalls.length }) ?? Response.json({ ok: true })
    )
  }) as typeof fetch
  const config = getHostedSandboxConfig(
    state.dir,
    {
      ORCA_CLOUD_SANDBOX_URL: CONTROL_PLANE,
      ORCA_CLOUD_API_URL: 'http://127.0.0.1:9',
      ORCA_CLOUD_CLIENT_ID: 'test-client'
    },
    false,
    fetchImpl
  )
  if (!config) {
    throw new Error('expected a hosted sandbox config')
  }
  return {
    config,
    mints,
    controlCalls,
    /** Holds every mint response until the returned release() is called. */
    holdMints: () => {
      let release!: () => void
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null
          resolve()
        }
      })
      return release
    }
  }
}

function link(activeOrgId?: string, activeOrgName?: string): string {
  const profileId = ensureActiveOrcaProfile(state.dir).profile.id
  linkOrcaProfileToCloud(profileId, cloud(activeOrgId, activeOrgName), state.dir)
  return profileId
}

describe('sandbox token team checks', () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'orca-org-token-test-'))
    installFakeAppEnvironment({ getPath: () => state.dir })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    removeTreeSync(state.dir)
  })

  it('mints with the active team named explicitly, and null for a personal account', async () => {
    const h = harness({})
    link('org-1')
    expect(tokenOrg(`Bearer ${await h.config.getAccessToken()}`)).toBe('org-1')
    link()
    expect(tokenOrg(`Bearer ${await h.config.getAccessToken()}`)).toBeNull()
    expect(h.mints.map((m) => JSON.parse(m.body))).toEqual([{ orgId: 'org-1' }, { orgId: null }])
  })

  it('rejects a token for the wrong team, re-mints once, and caches only the right one', async () => {
    // Auth's membership mirror lacks the team the first time: it mints a personal token.
    const h = harness({ issue: (requested, call) => (call === 1 ? null : (requested ?? null)) })
    link('org-1')
    const token = await h.config.getAccessToken()
    expect(tokenOrg(`Bearer ${token}`)).toBe('org-1')
    expect(await h.config.getAccessToken()).toBe(token)
    expect(h.mints).toHaveLength(2)
  })

  it('never uses a wrong-team token: two mismatches surface a clear error', async () => {
    const h = harness({ issue: () => 'org-old' })
    link('org-new', 'Acme')
    const error = await h.config.getAccessToken().catch((caught: unknown) => caught)
    expect(isEnvironmentProviderError(error, 'conflict')).toBe(true)
    expect((error as Error).message).toBe("Couldn't switch to Acme. Sign out and back in.")
    // Nothing was cached: the next call asks auth again.
    await h.config.getAccessToken().catch(() => undefined)
    expect(h.mints).toHaveLength(4)
  })

  it('falls back to an empty body when auth predates the explicit-org body, and remembers', async () => {
    const h = harness({ mintStatus: (body) => (body === '{}' ? 200 : 400) })
    link()
    expect(tokenOrg(`Bearer ${await h.config.getAccessToken()}`)).toBeNull()
    h.config.invalidateAccessToken?.()
    await h.config.getAccessToken()
    expect(h.mints.map((m) => m.body)).toEqual(['{"orgId":null}', '{}', '{}'])
  })

  it('with the fallback, a team token missing its org claim is still refused', async () => {
    const h = harness({
      mintStatus: (body) => (body === '{}' ? 200 : 400),
      // Old auth picks from its mirror, which lacks the team: personal token.
      issue: () => null
    })
    link('org-1', 'Acme')
    const error = await h.config.getAccessToken().catch((caught: unknown) => caught)
    expect(isEnvironmentProviderError(error, 'conflict')).toBe(true)
  })

  it('switch race: a mint in flight for the old team is never cached for the new one', async () => {
    // Auth that ignores the body and answers with whichever team its session held when asked.
    let sessionOrg = 'org-old'
    const h = harness({ issue: () => sessionOrg })
    link('org-old')
    const release = h.holdMints()
    const pending = h.config.getAccessToken()
    // The switch commits while the old mint is in flight.
    sessionOrg = 'org-new'
    link('org-new')
    release()
    const token = await pending
    expect(tokenOrg(`Bearer ${token}`)).toBe('org-new')
    expect(tokenOrg(`Bearer ${await h.config.getAccessToken()}`)).toBe('org-new')
  })

  it('a role change drops the cached token', async () => {
    const h = harness({})
    const profileId = link('org-1')
    const key = `${profileId}:role-test`
    noteOrcaCloudMemberships(key, [{ orgId: 'org-1', name: 'Acme', role: 'owner' }])
    const first = await h.config.getAccessToken()
    expect(await h.config.getAccessToken()).toBe(first)
    noteOrcaCloudMemberships(key, [{ orgId: 'org-1', name: 'Acme', role: 'member' }])
    const second = await h.config.getAccessToken()
    expect(second).not.toBe(first)
    // Same roles again: no further re-mint.
    noteOrcaCloudMemberships(key, [{ orgId: 'org-1', name: 'Acme', role: 'member' }])
    expect(await h.config.getAccessToken()).toBe(second)
  })
})

describe('control-plane fetch', () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'orca-org-fetch-test-'))
    installFakeAppEnvironment({ getPath: () => state.dir })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    removeTreeSync(state.dir)
  })

  async function call(h: ReturnType<typeof harness>): Promise<Response> {
    const token = await h.config.getAccessToken()
    const controlPlaneFetch = h.config.fetch
    if (!controlPlaneFetch) {
      throw new Error('expected the control-plane fetch')
    }
    return controlPlaneFetch(new URL('/v1/sandboxes', CONTROL_PLANE), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{"a":1}'
    })
  }

  it('names the active team, or user for a personal account', async () => {
    const h = harness({})
    link('org-1')
    await call(h)
    link()
    await call(h)
    expect(h.controlCalls.map((headers) => headers.get('x-orca-org'))).toEqual(['org-1', 'user'])
  })

  it('409 org_mismatch drops the token, re-mints once, and retries with the new one', async () => {
    const h = harness({
      controlPlane: ({ call }) =>
        call === 1
          ? Response.json({ error: 'org_mismatch', reason: 'org_mismatch' }, { status: 409 })
          : Response.json({ ok: true })
    })
    link('org-1')
    const response = await call(h)
    expect(response.status).toBe(200)
    expect(h.mints).toHaveLength(2)
    const [first, retry] = h.controlCalls
    expect(retry!.get('authorization')).not.toBe(first!.get('authorization'))
    expect(tokenOrg(retry!.get('authorization'))).toBe('org-1')
    // The retry uses the fresh token, which is now the cached one.
    expect(`Bearer ${await h.config.getAccessToken()}`).toBe(retry!.get('authorization'))
  })

  it('401 stale_token re-mints once and retries instead of signing out', async () => {
    const h = harness({
      controlPlane: ({ call }) =>
        call === 1
          ? Response.json({ error: 'unauthorized', reason: 'stale_token' }, { status: 401 })
          : Response.json({ ok: true })
    })
    link('org-1')
    expect((await call(h)).status).toBe(200)
    expect(h.mints).toHaveLength(2)
  })

  it('a second org_mismatch surfaces the clear error rather than looping', async () => {
    const h = harness({
      controlPlane: () => Response.json({ error: 'org_mismatch' }, { status: 409 })
    })
    link('org-1', 'Acme')
    const error = await call(h).catch((caught: unknown) => caught)
    expect(isEnvironmentProviderError(error, 'conflict')).toBe(true)
    expect((error as Error).message).toBe("Couldn't switch to Acme. Sign out and back in.")
    expect(h.controlCalls).toHaveLength(2)
  })

  it('other refusals pass through untouched', async () => {
    const h = harness({
      controlPlane: () => Response.json({ error: 'unauthorized' }, { status: 401 })
    })
    link('org-1')
    expect((await call(h)).status).toBe(401)
    expect(h.controlCalls).toHaveLength(1)
  })
})
