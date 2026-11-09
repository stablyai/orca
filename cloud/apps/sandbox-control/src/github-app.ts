// GitHub App installation tokens for sandbox git: 1h, scoped to the workspace's one repository with
// contents + pull_requests write. Minted here, injected at the egress layer, never stored in the VM.
import { SignJWT, importPKCS8 } from 'jose'

export type GitHubRepoToken = { token: string; expiresAt: number }

export type GitHubAppMinter = {
  /** Null when the repo is not on github.com or the app is not installed on it. */
  tokenForRepo(repoUrl: string): Promise<GitHubRepoToken | null>
}

const REFRESH_MARGIN_MS = 5 * 60_000

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(repoUrl)
    const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.pathname)
    return url.protocol === 'https:' && url.hostname === 'github.com' && match
      ? { owner: match[1]!, repo: match[2]! }
      : null
  } catch {
    return null
  }
}

export function createGitHubAppMinter(config: {
  appId: string
  privateKeyPkcs8: string
  fetch?: typeof fetch
  now?: () => number
}): GitHubAppMinter {
  const doFetch = config.fetch ?? fetch
  const now = config.now ?? Date.now
  const cache = new Map<string, GitHubRepoToken>()
  let signingKey: CryptoKey | null = null

  async function appJwt(): Promise<string> {
    signingKey ??= await importPKCS8(config.privateKeyPkcs8, 'RS256')
    const iat = Math.floor(now() / 1000) - 60
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(config.appId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 9 * 60)
      .sign(signingKey)
  }

  async function github(method: string, path: string, body?: unknown): Promise<Response> {
    return doFetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await appJwt()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'orca-sandbox-control'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    })
  }

  return {
    async tokenForRepo(repoUrl) {
      const parsed = parseGitHubRepo(repoUrl)
      if (!parsed) {
        return null
      }
      const key = `${parsed.owner}/${parsed.repo}`.toLowerCase()
      const cached = cache.get(key)
      if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) {
        return cached
      }
      const installation = await github('GET', `/repos/${parsed.owner}/${parsed.repo}/installation`)
      if (installation.status === 404) {
        return null
      }
      if (!installation.ok) {
        throw new Error(`github installation lookup failed (${installation.status})`)
      }
      const { id } = (await installation.json()) as { id: number }
      const minted = await github('POST', `/app/installations/${id}/access_tokens`, {
        repositories: [parsed.repo],
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }
      })
      if (!minted.ok) {
        throw new Error(`github token mint failed (${minted.status})`)
      }
      const body = (await minted.json()) as { token: string; expires_at: string }
      const token = { token: body.token, expiresAt: Date.parse(body.expires_at) }
      cache.set(key, token)
      return token
    }
  }
}
