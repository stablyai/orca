// Where Orca Cloud sandboxes are managed and how the desktop authenticates there. Off by default:
// no packaged control-plane URL ships yet, so only builds that set ORCA_CLOUD_SANDBOX_URL see it.
import { createPrivateKey, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { cloudDevSigningAllowed } from '../cloud-build-defaults'
import { cleanCloudServiceUrl } from '../../shared/cloud-service-url'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'
import { runWithFreshOrcaCloudSession } from '../orca-profiles/profile-cloud-session-refresh'
import {
  ensureActiveOrcaProfile,
  type ActiveOrcaProfileState
} from '../orca-profiles/profile-index-store'
import { getOrcaProfileIndexGeneration } from '../orca-profiles/profile-index-generation'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'

export type HostedSandboxConfig = {
  controlPlaneUrl: string
  getAccessToken: (signal?: AbortSignal) => Promise<string>
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
}

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
  const fresh = (entry: CachedSandboxToken | null): entry is CachedSandboxToken =>
    entry !== null && entry.expiresAt - Date.now() > 60_000
  const mint = (active: ActiveOrcaProfileState) =>
    devKeyFile
      ? mintDevSandboxToken(devKeyFile, active.profile.cloud, env)
      : mintSandboxToken(userDataPath, active, env, packaged, fetchImpl)
  return {
    controlPlaneUrl,
    getAccessToken: async () => {
      // Why: sign-in, sign-out and team or profile switches all rewrite the profile index. A token
      // minted for the previous identity would create sandboxes the new one can't see or delete.
      if (fresh(cached) && cached.generation === getOrcaProfileIndexGeneration()) {
        return cached.token
      }
      for (let attempt = 0; ; attempt++) {
        const generation = getOrcaProfileIndexGeneration()
        const active = ensureActiveOrcaProfile(userDataPath)
        const identity = sandboxIdentity(active)
        if (fresh(cached) && cached.identity === identity) {
          cached = { ...cached, generation }
          return cached.token
        }
        const minted = await mint(active)
        // An identity change while minting must not hand the old identity's token to the caller.
        if (
          attempt === 0 &&
          generation !== getOrcaProfileIndexGeneration() &&
          sandboxIdentity(ensureActiveOrcaProfile(userDataPath)) !== identity
        ) {
          continue
        }
        cached = { ...minted, identity, generation }
        return minted.token
      }
    }
  }
}

function sandboxIdentity(active: ActiveOrcaProfileState): string {
  const cloud = active.profile.cloud
  return JSON.stringify([active.profile.id, cloud?.userId ?? null, cloud?.activeOrgId ?? null])
}

async function mintSandboxToken(
  userDataPath: string,
  active: ActiveOrcaProfileState,
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  fetchImpl: typeof fetch
): Promise<{ token: string; expiresAt: number }> {
  const auth = getOrcaCloudAuthConfig(env, packaged)
  if (!auth.configured || !active.profile.cloud) {
    throw new EnvironmentProviderError('unauthorized', 'Sign in to Orca to use Orca Cloud.')
  }
  const endpoint =
    cleanCloudServiceUrl(env.ORCA_CLOUD_SANDBOX_TOKEN_URL, !packaged) ??
    new URL('/v1/desktop/auth/sandbox-token', `${auth.config.apiBaseUrl}/`).toString()
  const result = await runWithFreshOrcaCloudSession(
    auth.config,
    active,
    userDataPath,
    async (session) => {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.accessToken}`
        },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      })
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
