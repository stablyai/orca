import { createSign } from 'node:crypto'
import { z } from 'zod'
import type { SigningConfig } from './config.js'

export interface SigningApis {
  github(path: string, body?: unknown): Promise<unknown>
  signpath(requestId: string): Promise<unknown>
}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    path: string
  ) {
    super(`Upstream request failed (${status}): ${path}`)
  }
}
const tokenSchema = z.object({
  token: z.string(),
  expires_at: z.string().datetime()
})

export function createSigningApis(config: SigningConfig, fetchImpl = fetch): SigningApis {
  let cached: z.infer<typeof tokenSchema> | undefined
  let tokenRequest: Promise<string> | undefined
  async function token(): Promise<string> {
    if (cached && Date.parse(cached.expires_at) > Date.now() + 60_000) return cached.token
    if (tokenRequest) return tokenRequest
    tokenRequest = (async () => {
      const now = Math.floor(Date.now() / 1000)
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
      const claims = Buffer.from(
        JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId })
      ).toString('base64url')
      const payload = `${header}.${claims}`
      const signature = createSign('RSA-SHA256')
        .update(payload)
        .sign(config.privateKey, 'base64url')
      const response = await fetchImpl(
        `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${payload}.${signature}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            repositories: [config.repository.split('/')[1]],
            permissions: {
              actions: 'read',
              contents: 'read',
              deployments: 'write'
            }
          }),
          signal: AbortSignal.timeout(15_000),
          redirect: 'error'
        }
      )
      if (!response.ok) throw new ApiError(response.status, 'installation token')
      cached = tokenSchema.parse(await response.json())
      return cached.token
    })()
    try {
      return await tokenRequest
    } finally {
      tokenRequest = undefined
    }
  }
  return {
    async github(path, body) {
      if (!path.startsWith(`/repos/${config.repository}/`))
        throw new Error('Repository scope mismatch')
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${await token()}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error'
      })
      if (!response.ok) throw new ApiError(response.status, path)
      return response.status === 204 ? null : response.json()
    },
    async signpath(requestId) {
      z.string().uuid().parse(requestId)
      const response = await fetchImpl(
        `https://app.signpath.io/Api/v1/${config.signpathOrganization}/SigningRequests/${requestId}`,
        {
          headers: { authorization: `Bearer ${config.signpathToken}` },
          signal: AbortSignal.timeout(15_000),
          redirect: 'error'
        }
      )
      if (!response.ok) throw new ApiError(response.status, 'SignPath request')
      return response.json()
    }
  }
}
