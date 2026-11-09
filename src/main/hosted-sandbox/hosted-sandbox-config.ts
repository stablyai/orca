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
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
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
  let cached: { token: string; expiresAt: number } | null = null
  return {
    controlPlaneUrl,
    getAccessToken: async () => {
      if (cached && cached.expiresAt - Date.now() > 60_000) {
        return cached.token
      }
      cached = devKeyFile
        ? await mintDevSandboxToken(
            devKeyFile,
            ensureActiveOrcaProfile(userDataPath).profile.cloud,
            env
          )
        : await mintSandboxToken(userDataPath, env, packaged, fetchImpl)
      return cached.token
    }
  }
}

async function mintSandboxToken(
  userDataPath: string,
  env: NodeJS.ProcessEnv,
  packaged: boolean,
  fetchImpl: typeof fetch
): Promise<{ token: string; expiresAt: number }> {
  const auth = getOrcaCloudAuthConfig(env, packaged)
  const active = ensureActiveOrcaProfile(userDataPath)
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

/** Dev builds only: sign with the dev operator key the dev control plane trusts (issuer orca-sandbox-dev-test). */
async function mintDevSandboxToken(
  keyFile: string,
  cloud: { userId: string; activeOrgId?: string } | undefined,
  env: NodeJS.ProcessEnv
): Promise<{ token: string; expiresAt: number }> {
  const userId = cloud?.userId
  // Team dogfood: two dev profiles in one dev org share workspaces; the role comes from env.
  const orgRole = env.ORCA_CLOUD_SANDBOX_DEV_ORG_ROLE?.trim()
  const org = cloud?.activeOrgId
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
    sub: userId ?? 'desktop-dogfood',
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
