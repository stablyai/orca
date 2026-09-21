import { Buffer } from 'node:buffer'

export const DEFAULT_API_BASE_URL = 'https://api.bitbucket.org/2.0'

// Two interchangeable Bitbucket Cloud auth shapes: a single access token (Bearer)
// or an email + API token pair (HTTP Basic). Either satisfies `hasAuth`, and both
// may come from env vars or the in-app credential store.
export type BitbucketAuthConfig = {
  baseUrl: string
  accessToken: string | null
  email: string | null
  apiToken: string | null
}

export function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

export function getEnvAuthConfig(): BitbucketAuthConfig {
  return {
    baseUrl: envValue('ORCA_BITBUCKET_API_BASE_URL') ?? DEFAULT_API_BASE_URL,
    accessToken: envValue('ORCA_BITBUCKET_ACCESS_TOKEN'),
    email: envValue('ORCA_BITBUCKET_EMAIL'),
    apiToken: envValue('ORCA_BITBUCKET_API_TOKEN')
  }
}

export function hasAuth(config: BitbucketAuthConfig): boolean {
  return Boolean(config.accessToken || (config.email && config.apiToken))
}

export function authHeaders(config: BitbucketAuthConfig): Record<string, string> {
  if (config.accessToken) {
    return { Authorization: `Bearer ${config.accessToken}` }
  }
  if (config.email && config.apiToken) {
    const encoded = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
  return {}
}
