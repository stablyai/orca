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
  /**
   * Repo token (contents + pull requests). `issues: true` also asks for issues:write (routine comments on
   * plain issues); an installation that has not accepted that permission yet gets the standard token.
   */
  tokenForRepo(repoUrl: string, accountId: string, options?: { issues?: boolean }): Promise<GitHubRepoToken | null>
  /** App-level installation lookup (operator binding). Null when absent. */
  getInstallation(installationId: number): Promise<GitHubInstallation | null>
  /** The installation covering a github.com repo URL, or null. */
  getRepoInstallation(repoUrl: string): Promise<GitHubInstallation | null>
  /**
   * The App's installation on a GitHub org or user (whatever repositories it selected), or null.
   * Tells "not installed on the owner" from "installed, but this repository isn't selected".
   */
  getOwnerInstallation?(owner: string): Promise<GitHubInstallation | null>
  /** App-JWT request to an app-level endpoint (operator: /app, /app/hook/config). */
  appRequest?(method: string, path: '/app' | '/app/hook/config', body?: unknown): Promise<Response>
  /**
   * Operator-only (golden image source builds): repo installation lookup and installation token mint.
   * Any other path is refused, so this can't be bent into acting for a customer account.
   */
  sourceRequest?(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response>
  /**
   * One page (100) of the repositories an installation can reach, read with a metadata-only
   * installation token that never leaves this Worker. Callers check the account's binding first.
   */
  listInstallationRepositories?(installationId: number, page: number): Promise<{ repositories: GitHubListedRepo[]; totalCount: number }>
  /** Owners (lowercased logins) with a pending install request for this app (GET /app/installation-requests). */
  pendingRequestOwners?(): Promise<Set<string>>
  /**
   * The GitHub user's membership in the installation's org, read with a members:read installation
   * token (GET /orgs/{org}/memberships/{login}). Null when not a member or GitHub can't say.
   */
  orgMembership?(installationId: number, org: string, login: string): Promise<{ state: string; role: string; userId: number } | null>
}

export type GitHubListedRepo = {
  id: number
  fullName: string
  private: boolean
  defaultBranch: string | null
  pushedAt: string | null
}

/** Whether `accountId` holds a live binding to the installation. */
export type InstallationBindingCheck = (installationId: number, accountId: string) => Promise<boolean>

const REFRESH_MARGIN_MS = 5 * 60_000
const REPO_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const

const OrgMembershipBody = z.looseObject({
  state: z.string(),
  role: z.string(),
  user: z.looseObject({ id: z.number().int().positive() })
})

const Installation = z.looseObject({
  id: z.number().int().positive(),
  account: z.looseObject({ id: z.number().int(), login: z.string(), type: z.enum(['User', 'Organization']) })
})
const MintedToken = z.looseObject({
  token: z.string().min(1),
  expires_at: z.string(),
  repositories: z.array(z.looseObject({ id: z.number(), name: z.string() })).optional()
})

const InstallationRepositories = z.looseObject({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(
    z.looseObject({
      id: z.number().int(),
      full_name: z.string(),
      private: z.boolean(),
      default_branch: z.string().nullish(),
      pushed_at: z.string().nullish()
    })
  )
})
const InstallationRequests = z.array(z.looseObject({ account: z.looseObject({ login: z.string() }) }))

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

  const metadataTokens = new Map<number, { token: string; expiresAt: number }>()
  async function metadataToken(installationId: number): Promise<string> {
    const cached = metadataTokens.get(installationId)
    if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) {
      return cached.token
    }
    const minted = await github('POST', `/app/installations/${installationId}/access_tokens`, { permissions: { metadata: 'read' } })
    const body = MintedToken.safeParse(await minted.json().catch(() => null))
    if (!minted.ok || !body.success) {
      throw new Error(`github metadata token mint failed (${minted.status})`)
    }
    const token = { token: body.data.token, expiresAt: Date.parse(body.data.expires_at) }
    metadataTokens.set(installationId, token)
    return token.token
  }
  let requestOwners: { at: number; owners: Set<string> } | null = null

  return {
    getInstallation: (installationId) => installationFor(`/app/installations/${installationId}`),

    async orgMembership(installationId, org, login) {
      const minted = await github('POST', `/app/installations/${installationId}/access_tokens`, { permissions: { members: 'read' } })
      const token = MintedToken.safeParse(await minted.json().catch(() => null))
      if (!minted.ok || !token.success) {
        return null
      }
      const response = await doFetch(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`,
        {
          headers: {
            authorization: `Bearer ${token.data.token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'orca-sandbox-control'
          },
          redirect: 'manual'
        }
      )
      const body = OrgMembershipBody.safeParse(await response.json().catch(() => null))
      return response.ok && body.success ? { state: body.data.state, role: body.data.role, userId: body.data.user.id } : null
    },

    async listInstallationRepositories(installationId, page) {
      const token = await metadataToken(installationId)
      const response = await doFetch(`https://api.github.com/installation/repositories?per_page=100&page=${Math.max(1, Math.floor(page))}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'orca-sandbox-control'
        },
        redirect: 'manual'
      })
      const body = InstallationRepositories.safeParse(await response.json().catch(() => null))
      if (!response.ok || !body.success) {
        throw new Error(`github installation repositories failed (${response.status})`)
      }
      return {
        totalCount: body.data.total_count,
        repositories: body.data.repositories.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          private: r.private,
          defaultBranch: r.default_branch ?? null,
          pushedAt: r.pushed_at ?? null
        }))
      }
    },

    async pendingRequestOwners() {
      // One app-wide list, shared by every repo-access check for a minute: the settled list only, never a
      // request in flight (an in-flight one shared across requests hangs them all if its request is cancelled).
      if (requestOwners && now() - requestOwners.at <= 60_000) {
        return requestOwners.owners
      }
      const response = await github('GET', '/app/installation-requests?per_page=100')
      const body = InstallationRequests.safeParse(await response.json().catch(() => null))
      if (!response.ok || !body.success) {
        throw new Error(`github installation requests failed (${response.status})`)
      }
      const owners = new Set(body.data.map((r) => r.account.login.toLowerCase()))
      requestOwners = { at: now(), owners }
      return owners
    },

    appRequest: (method, path, body) => github(method, path, body),

    sourceRequest: async (method, path, body) => {
      const allowed =
        (method === 'GET' && /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/installation$/.test(path)) ||
        (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path))
      if (!allowed) {
        throw new Error('github source request refused')
      }
      return github(method, path, body)
    },

    async getOwnerInstallation(owner) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) {
        return null
      }
      // Orgs and users have separate lookups; an org login 404s on /users/{login}/installation.
      return (await installationFor(`/orgs/${owner}/installation`)) ?? installationFor(`/users/${owner}/installation`)
    },

    async getRepoInstallation(repoUrl) {
      const parsed = parseGitHubRepo(repoUrl)
      return parsed ? installationFor(`/repos/${parsed.owner}/${parsed.repo}/installation`) : null
    },

    async tokenForRepo(repoUrl, accountId, options = {}) {
      const parsed = parseGitHubRepo(repoUrl)
      if (!parsed) {
        return null
      }
      // Separate cache entries: an issues token is never handed to the VM's git/gh path.
      const key = `${parsed.owner}/${parsed.repo}${options.issues ? '#issues' : ''}`.toLowerCase()
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
        permissions: options.issues ? { ...REPO_PERMISSIONS, issues: 'write' } : REPO_PERMISSIONS
      })
      if (!minted.ok && options.issues && minted.status === 422) {
        // The installation has not accepted issues:write: PR comments still work with the standard token.
        log({ event: 'github_issues_permission_missing', installationId: installation.id })
        return this.tokenForRepo(repoUrl, accountId)
      }
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
