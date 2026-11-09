// GitHub App installation tokens for sandbox git: 1h, scoped to the workspace's one repository with
// contents + pull_requests write. Minted here, injected at the egress layer, never stored in the VM.
// A token is minted only when the caller's Orca account is bound to the installation that covers the
// repo (github-connect.ts records bindings); an app installed on a repo is not by itself a grant.
import { SignJWT, importPKCS8 } from 'jose'
import { z } from 'zod'

export type GitHubRepoToken = { token: string; expiresAt: number }

export type GitHubInstallation = {
  id: number
  account: { id: number; login: string; type: 'User' | 'Organization' }
}

export type GitHubAppMinter = {
  /**
   * Null when the repo is not on github.com, the app is not installed on it, or the installation is
   * not bound to `accountId`. Deny by default.
   */
  tokenForRepo(repoUrl: string, accountId: string): Promise<GitHubRepoToken | null>
  /** App-level installation lookup (operator binding). Null when absent. */
  getInstallation(installationId: number): Promise<GitHubInstallation | null>
  /** The installation covering a github.com repo URL, or null. */
  getRepoInstallation(repoUrl: string): Promise<GitHubInstallation | null>
}

/** Whether `accountId` holds a live binding to the installation. */
export type InstallationBindingCheck = (installationId: number, accountId: string) => Promise<boolean>

const REFRESH_MARGIN_MS = 5 * 60_000
const REPO_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const

const Installation = z.looseObject({
  id: z.number().int().positive(),
  account: z.looseObject({ id: z.number().int(), login: z.string(), type: z.enum(['User', 'Organization']) })
})
const MintedToken = z.looseObject({
  token: z.string().min(1),
  expires_at: z.string(),
  repositories: z.array(z.looseObject({ id: z.number(), name: z.string() })).optional()
})

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(repoUrl)
    const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.pathname)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && match
      ? { owner: match[1]!, repo: match[2]! }
      : null
  } catch {
    return null
  }
}

export function createGitHubAppMinter(config: {
  appId: string
  privateKeyPkcs8: string
  isBound: InstallationBindingCheck
  fetch?: typeof fetch
  now?: () => number
  log?: (event: Record<string, unknown>) => void
}): GitHubAppMinter {
  const doFetch = config.fetch ?? fetch
  const now = config.now ?? Date.now
  const log = config.log ?? ((event) => console.log(JSON.stringify(event)))
  const cache = new Map<string, GitHubRepoToken & { installationId: number }>()
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

  async function installationFor(path: string): Promise<GitHubInstallation | null> {
    const response = await github('GET', path)
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(`github installation lookup failed (${response.status})`)
    }
    const parsed = Installation.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new Error('github installation lookup answered an unexpected body')
    }
    return parsed.data
  }

  return {
    getInstallation: (installationId) => installationFor(`/app/installations/${installationId}`),

    async getRepoInstallation(repoUrl) {
      const parsed = parseGitHubRepo(repoUrl)
      return parsed ? installationFor(`/repos/${parsed.owner}/${parsed.repo}/installation`) : null
    },

    async tokenForRepo(repoUrl, accountId) {
      const parsed = parseGitHubRepo(repoUrl)
      if (!parsed) {
        return null
      }
      const key = `${parsed.owner}/${parsed.repo}`.toLowerCase()
      const cached = cache.get(key)
      if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) {
        // The binding is re-checked on every use: a revoked binding stops a cached token too.
        return (await config.isBound(cached.installationId, accountId)) ? { token: cached.token, expiresAt: cached.expiresAt } : null
      }
      const installation = await installationFor(`/repos/${parsed.owner}/${parsed.repo}/installation`)
      if (!installation) {
        return null
      }
      if (!(await config.isBound(installation.id, accountId))) {
        log({ event: 'github_token_denied', reason: 'installation_not_bound', installationId: installation.id })
        return null
      }
      const minted = await github('POST', `/app/installations/${installation.id}/access_tokens`, {
        repositories: [parsed.repo],
        permissions: REPO_PERMISSIONS
      })
      if (!minted.ok) {
        throw new Error(`github token mint failed (${minted.status})`)
      }
      const body = MintedToken.safeParse(await minted.json().catch(() => null))
      // GitHub narrows to the named repo; refuse anything wider than that one repository.
      if (
        !body.success ||
        !body.data.repositories ||
        body.data.repositories.length !== 1 ||
        body.data.repositories[0]!.name.toLowerCase() !== parsed.repo.toLowerCase()
      ) {
        throw new Error('github token mint answered an unexpected scope')
      }
      const token = { token: body.data.token, expiresAt: Date.parse(body.data.expires_at) }
      cache.set(key, { ...token, installationId: installation.id })
      return token
    }
  }
}
