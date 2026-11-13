// Where Orca Cloud sandboxes are managed and how the desktop authenticates there. Off by default:
// no packaged control-plane URL ships yet, so only builds that set ORCA_CLOUD_SANDBOX_URL see it.
import { createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { cloudDevSigningAllowed } from '../cloud-build-defaults'
import { cleanCloudServiceUrl } from '../../shared/cloud-service-url'
import { getOrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
import { runWithFreshOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-refresh'
import {
  ensureActiveOrcaProfile,
  type ActiveOrcaProfileState
} from '../orca-profiles/profile-index-store'
import { getOrcaProfileIndexGeneration } from '../orca-profiles/profile-index-generation'
import { getOrcaCloudTokenEpoch } from '../orca-profiles/cloud-token-epoch'
import { createOrgCheckedFetch, ORCA_ORG_HEADER_PERSONAL } from './hosted-sandbox-org-fetch'
import { isNotAMember, orgSwitchError, readTokenOrg } from './hosted-sandbox-token-org'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'

export type HostedSandboxConfig = {
  controlPlaneUrl: string
  getAccessToken: (signal?: AbortSignal) => Promise<string>
  /** Drops the cached token so the next call mints one (the control plane said it predates a role change). */
  invalidateAccessToken?: () => void
  /**
   * fetch for control-plane calls: adds `x-orca-org` (the team the desktop shows, or `user`), and
   * on a 409 org_mismatch or a stale_token refusal re-mints once and retries.
   */
  fetch?: typeof fetch
}

/** `reason` on the provider error when the team's MFA policy refused the token. */
export const MFA_REQUIRED_REASON = 'mfa_required'

/** Reads a copy of the body, so the caller can still read the response. */
export async function isMfaRequiredRefusal(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json()
    return (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      body.error === MFA_REQUIRED_REASON
    )
  } catch {
    return false
  }
}

const SandboxTokenBody = z.object({
  sandboxToken: z.string().min(1).max(8192),
  expiresAt: z.number().int().positive()
})

const DevKeyFile = z.object({
  private: z.looseObject({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string(),
    y: z.string(),
    d: z.string(),
    kid: z.string().optional()
  })
})

type CachedSandboxToken = {
  token: string
  expiresAt: number
  /** Who the token speaks for; a different signed-in user, team or profile never reuses it. */
  identity: string
  /** Profile index generation the identity was last confirmed at. */
  generation: number
  /** Team-switch / membership / role epoch the token was minted under; any change drops it. */
  epoch: number
}

type MintedSandboxToken = { token: string; expiresAt: number }

/** Sandbox tokens are minted per call by Orca Cloud auth; cached until a minute before expiry. */
export function getHostedSandboxConfig(
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env,
  packaged = false,
  fetchImpl: typeof fetch = fetch
): HostedSandboxConfig | null {
  const controlPlaneUrl = cleanCloudServiceUrl(env.ORCA_CLOUD_SANDBOX_URL, !packaged)
  if (!controlPlaneUrl) {
    return null
  }
  const devKeyFile = cloudDevSigningAllowed(packaged)
    ? env.ORCA_CLOUD_SANDBOX_DEV_KEY_FILE?.trim()
    : undefined
  let cached: CachedSandboxToken | null = null
  const explicitOrg: ExplicitOrgSupport = { unsupportedUntil: 0 }
  let inflight: {
    identity: string
    epoch: number
    promise: Promise<MintedSandboxToken>
  } | null = null
  const fresh = (entry: CachedSandboxToken | null): entry is CachedSandboxToken =>
    entry !== null &&
    entry.expiresAt - Date.now() > 60_000 &&
    entry.epoch === getOrcaCloudTokenEpoch()
  const mint = (active: ActiveOrcaProfileState) =>
    devKeyFile
      ? mintDevSandboxToken(devKeyFile, active.profile.cloud, env)
      : mintSandboxToken(userDataPath, active, env, packaged, fetchImpl, explicitOrg)
  // Concurrent callers for the same identity and epoch share one mint.
  const sharedMint = (active: ActiveOrcaProfileState, identity: string, epoch: number) => {
    if (inflight?.identity === identity && inflight.epoch === epoch) {
      return inflight.promise
    }
    const entry = { identity, epoch, promise: mint(active) }
    inflight = entry
    void entry.promise
      .catch(() => undefined)
      .finally(() => {
        if (inflight === entry) {
          inflight = null
        }
      })
    return entry.promise
  }
  const getAccessToken = async (): Promise<string> => {
    // Why: sign-in, sign-out and team or profile switches all rewrite the profile index. A token
    // minted for the previous identity would create sandboxes the new one can't see or delete.
    if (fresh(cached) && cached.generation === getOrcaProfileIndexGeneration()) {
      return cached.token
    }
    let orgMismatches = 0
    for (let attempt = 0; ; attempt++) {
      const generation = getOrcaProfileIndexGeneration()
      const epoch = getOrcaCloudTokenEpoch()
      const active = ensureActiveOrcaProfile(userDataPath)
      const identity = sandboxIdentity(active)
      if (fresh(cached) && cached.identity === identity) {
        cached = { ...cached, generation }
        return cached.token
      }
      // Only one identity is ever cached: a switch drops every other team's token.
      cached = null
      const pending = sharedMint(active, identity, epoch)
      const minted = await pending
      // An identity, team or role change while minting must not hand the old token to the caller.
      const identityMoved =
        generation !== getOrcaProfileIndexGeneration() &&
        sandboxIdentity(ensureActiveOrcaProfile(userDataPath)) !== identity
      if (identityMoved || epoch !== getOrcaCloudTokenEpoch()) {
        if (attempt >= 2) {
          throw new EnvironmentProviderError(
            'unavailable',
            'Your Orca account changed while signing in to Orca Cloud. Try again.'
          )
        }
        continue
      }
      // Why: auth may still pick the team from session state (the old team mid-switch). Never
      // cache or use a token for any team other than the one this identity asked for.
      const requestedOrg = active.profile.cloud?.activeOrgId ?? null
      const tokenOrg = readTokenOrg(minted.token)
      if (tokenOrg !== requestedOrg) {
        console.warn(
          `[orca-cloud] sandbox token org mismatch: requested=${requestedOrg ?? 'user'} got=${tokenOrg ?? 'user'}`
        )
        orgMismatches++
        // The re-mint must ask auth again, not share the refused answer.
        if (inflight?.promise === pending) {
          inflight = null
        }
        if (orgMismatches >= 2) {
          throw orgSwitchError(active)
        }
        continue
      }
      cached = { ...minted, identity, generation, epoch }
      return minted.token
    }
  }
  const invalidateAccessToken = (): void => {
    // A fresh mint on the next call; one already in flight is fresh anyway.
    cached = null
  }
  return {
    controlPlaneUrl,
    getAccessToken,
    invalidateAccessToken,
    fetch: createOrgCheckedFetch({
      fetchImpl,
      orgHeader: () =>
        ensureActiveOrcaProfile(userDataPath).profile.cloud?.activeOrgId ??
        ORCA_ORG_HEADER_PERSONAL,
      getAccessToken,
      invalidateAccessToken,
      orgSwitchError: () => orgSwitchError(ensureActiveOrcaProfile(userDataPath))
    })
  }
}

function sandboxIdentity(active: ActiveOrcaProfileState): string {
  const cloud = active.profile.cloud
  return JSON.stringify([active.profile.id, cloud?.userId ?? null, cloud?.activeOrgId ?? null])
}

/** Auth older than the explicit-org mint body answers 400; skip the body for a while after one. */
type ExplicitOrgSupport = { unsupportedUntil: number }
const EXPLICIT_ORG_RETRY_MS = 10 * 60_000

async function mintSandboxToken(
  userDataPath: string,
  active: ActiveOrcaProfileState,
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  fetchImpl: typeof fetch,
  explicitOrg: ExplicitOrgSupport
): Promise<{ token: string; expiresAt: number }> {
  const auth = getOrcaCloudAuthConfig(env, packaged)
  if (!auth.configured || !active.profile.cloud) {
    throw new EnvironmentProviderError('unauthorized', 'Sign in to Orca to use Orca Cloud.')
  }
  const requestedOrg = active.profile.cloud.activeOrgId ?? null
  const endpoint =
    cleanCloudServiceUrl(env.ORCA_CLOUD_SANDBOX_TOKEN_URL, !packaged) ??
    new URL('/v1/desktop/auth/sandbox-token', `${auth.config.apiBaseUrl}/`).toString()
  const result = await runWithFreshOrcaCloudSession(
    auth.config,
    active,
    userDataPath,
    async (session) => {
      const post = (body: string) =>
        fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.accessToken}`
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000)
        })
      // Ask for the team explicitly; auth must not pick it from session state mid-switch.
      const explicit = Date.now() >= explicitOrg.unsupportedUntil
      let response = await post(explicit ? JSON.stringify({ orgId: requestedOrg }) : '{}')
      if (explicit && response.status === 400) {
        // Auth older than the explicit-org contract rejects any body. The caller's org-claim check
        // still refuses a token for the wrong team.
        explicitOrg.unsupportedUntil = Date.now() + EXPLICIT_ORG_RETRY_MS
        response = await post('{}')
      }
      if (response.status === 403 && requestedOrg && (await isNotAMember(response))) {
        throw orgSwitchError(active)
      }
      if (response.status === 403 && (await isMfaRequiredRefusal(response))) {
        // The team requires MFA and this person has none past the deadline. Signing in again
        // would not help, so this is not a session error: the reason lets the UI show setup.
        throw new EnvironmentProviderError(
          'unauthorized',
          'Your team requires two-factor authentication. Set it up to use its cloud workspaces.',
          MFA_REQUIRED_REASON
        )
      }
      if (response.status === 401 || response.status === 403) {
        throw new OrcaCloudRequestError(response.status)
      }
      if (!response.ok) {
        throw new EnvironmentProviderError(
          'unavailable',
          `Orca Cloud auth answered ${response.status}.`
        )
      }
      const body = SandboxTokenBody.safeParse(await response.json())
      if (!body.success) {
        throw new EnvironmentProviderError(
          'invalid_response',
          'Orca Cloud auth sent an invalid sandbox token.'
        )
      }
      return { token: body.data.sandboxToken, expiresAt: body.data.expiresAt }
    }
  )
  if (result.status !== 'ok') {
    throw new EnvironmentProviderError('unauthorized', 'Sign in to Orca to use Orca Cloud.')
  }
  return result.value
}

/**
 * Dev builds only: sign with the dev operator key the dev control plane trusts (issuer
 * orca-sandbox-dev-test), as the signed-in Orca user. Signed out is an error, never a fallback
 * identity: a sandbox created as anyone else can't be kept alive or deleted after sign-in.
 */
async function mintDevSandboxToken(
  keyFile: string,
  cloud: { userId: string; activeOrgId?: string; displayName?: string } | undefined,
  env: NodeJS.ProcessEnv
): Promise<{ token: string; expiresAt: number }> {
  const userId = cloud?.userId?.trim()
  if (!cloud || !userId) {
    throw new EnvironmentProviderError('unauthorized', 'Sign in to Orca to use Orca Cloud.')
  }
  // Team dogfood: two dev profiles in one dev org share workspaces; the role comes from env.
  const orgRole = env.ORCA_CLOUD_SANDBOX_DEV_ORG_ROLE?.trim()
  const org = cloud.activeOrgId
    ? {
        org: cloud.activeOrgId,
        org_role: orgRole === 'owner' || orgRole === 'admin' ? orgRole : 'member'
      }
    : {}
  const parsed = DevKeyFile.parse(JSON.parse(await readFile(keyFile, 'utf8')))
  const key = createPrivateKey({ key: parsed.private, format: 'jwk' })
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({
    alg: 'ES256',
    kid: parsed.private.kid ?? 'dev1'
  })
  const payload = encode({
    sub: userId,
    // Auth mints a display-name claim; dev tokens carry one so labels look real.
    ...(cloud.displayName ? { name: cloud.displayName.slice(0, 80) } : {}),
    ...org,
    purpose: 'sandbox',
    iss: 'orca-sandbox-dev-test',
    aud: 'orca-sandbox',
    iat: now,
    exp: now + 300
  })
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: 'ieee-p1363'
  })
  return {
    token: `${header}.${payload}.${signature.toString('base64url')}`,
    expiresAt: (now + 300) * 1000
  }
}
