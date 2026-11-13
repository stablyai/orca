// Can Orca Cloud clone this repository for this account, and if not, what fixes it? Checked when
// Orca Cloud is picked (cloud-start onboarding D1/D2), never after a build fails.
//   GET /v1/github/repo-access?repo=<https github url>[&session=cs_…][&repoId=&ownerId=]
//        -> {access:'public'|'granted'|'missing'|'requested', owner, installUrl?, canInstall?}
//      canInstall (only when the App isn't installed for the owner: 'missing', or 'public' with no
//      installation): true = the caller can install it on the owner (it is their own GitHub account, or
//      they are an active admin of the owner org); false = they'd have to ask an owner; null = unknown
//      (no connected GitHub user token, or GitHub didn't answer).
//   GET /v1/github/repositories[?cursor=]  -> {repositories, nextCursor}   (start from GitHub, D4/N12)
//   GET /v1/internal/github/install-url?accountId&userId&repo&session  (billing's setup chain,
//        Bearer CONTROL_PLANE_TOKEN) -> {access, url}
// `granted` means the same test the lifecycle applies before a create: the App's installation covers
// the repo and is bound to the caller's account. `requested` means a member who isn't an owner of
// the org on GitHub asked an owner to approve the App; the installation webhook finishes it.
// Billing's setup session (cloud-setup.ts) is told about each change, so a waiting desktop starts on
// its own: POST <billing>/v1/internal/cloud-setup/github {sessionId?, accountId, repo, state}.
import type { GitHubAppMinter, GitHubListedRepo } from './github-app'
import { parseGitHubRepo } from './github-app'
import {
  bindApprovedRequests,
  boundAccounts,
  createConnectState,
  installUrl,
  isInstallationBound,
  listAccountInstallations,
  openInstallRequest,
  revokeInstallation,
  type GitHubConnectConfig
} from './github-connect'

export type RepoAccess = 'public' | 'granted' | 'missing' | 'requested'

export type RepoAccessDeps = {
  db: D1Database
  github: GitHubAppMinter | undefined
  connect: GitHubConnectConfig | null
  publicRepoCheck: (repoUrl: string) => Promise<boolean>
  /** Anonymous api.github.com reads (owner/repo ids for the install URL) and the caller's own membership read. */
  fetch: typeof fetch
  now: number
  /** The caller's connected GitHub user (live token, refreshed when near expiry); null when not connected or unusable. */
  githubUser?: (caller: { accountId: string; userId: string }) => Promise<{ login: string; token: string } | null>
}

/** https://github.com/<owner>/<repo>: the one form repo URLs take on this wire and toward billing. */
export function canonicalRepoUrl(parsed: { owner: string; repo: string }): string {
  return `https://github.com/${parsed.owner}/${parsed.repo}`
}

export async function repoAccess(
  deps: RepoAccessDeps,
  accountId: string,
  repoUrl: string
): Promise<{ access: RepoAccess; owner: string; installationId: number | null }> {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) {
    throw new RepoAccessError('not_github')
  }
  const installation = deps.github ? await deps.github.getRepoInstallation(repoUrl) : null
  if (installation && (await isInstallationBound(deps.db, installation.id, accountId))) {
    return { access: 'granted', owner: parsed.owner, installationId: installation.id }
  }
  if (await deps.publicRepoCheck(repoUrl)) {
    return { access: 'public', owner: parsed.owner, installationId: installation?.id ?? null }
  }
  if (!installation && (await openInstallRequest(deps.db, accountId, parsed.owner, deps.now))) {
    // Ours, and still open on GitHub (an owner who declines leaves no webhook, only an empty list).
    const pending = await deps.github?.pendingRequestOwners?.().catch(() => null)
    if (!pending || pending.has(parsed.owner.toLowerCase())) {
      return { access: 'requested', owner: parsed.owner, installationId: null }
    }
  }
  return { access: 'missing', owner: parsed.owner, installationId: installation?.id ?? null }
}

export class RepoAccessError extends Error {
  constructor(readonly code: 'not_github' | 'not_configured') {
    super(code)
    this.name = 'RepoAccessError'
  }
}

const ownerIds = new Map<string, number>()

/**
 * Numeric ids for GitHub's preselecting install page. The owner id is public (GET /users/:login).
 * A private repository's id isn't readable anonymously, so the desktop may pass ids it read with the
 * user's own GitHub CLI; they only shape GitHub's page, which the user still confirms.
 */
async function preselectIds(
  deps: RepoAccessDeps,
  parsed: { owner: string; repo: string },
  hints: { repoId?: number; ownerId?: number }
): Promise<{ ownerId: number; repoId: number } | null> {
  if (!hints.repoId) {
    return null
  }
  const ownerId = hints.ownerId ?? ownerIds.get(parsed.owner.toLowerCase()) ?? (await anonymousOwnerId(deps.fetch, parsed.owner))
  return ownerId ? { ownerId, repoId: hints.repoId } : null
}

async function anonymousOwnerId(doFetch: typeof fetch, owner: string): Promise<number | null> {
  try {
    const response = await doFetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'orca-sandbox-control' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000)
    })
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null
    const id = response.ok && typeof body?.id === 'number' && Number.isSafeInteger(body.id) && body.id > 0 ? body.id : null
    if (id) {
      ownerIds.set(owner.toLowerCase(), id)
    }
    return id
  } catch {
    return null
  }
}

/** A fresh, single-use install URL bound to this caller (and setup session), preselecting the repo when it can. */
export async function repoInstallUrl(
  deps: RepoAccessDeps,
  caller: { accountId: string; userId: string },
  repoUrl: string,
  options: { setupSessionId?: string; repoId?: number; ownerId?: number; githubUser?: { id: number; login: string } } = {}
): Promise<{ url: string; state: string }> {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) {
    throw new RepoAccessError('not_github')
  }
  if (!deps.connect) {
    throw new RepoAccessError('not_configured')
  }
  const state = await createConnectState(deps.db, deps.connect.stateSecret, caller, deps.now, {
    setupSessionId: options.setupSessionId,
    repo: parsed,
    ...(options.githubUser ? { githubUser: options.githubUser } : {})
  })
  return { url: installUrl(deps.connect, state, await preselectIds(deps, parsed, options)), state }
}

/** Desktop route body for GET /v1/github/repo-access. */
export async function repoAccessView(
  deps: RepoAccessDeps,
  caller: { accountId: string; userId: string },
  url: URL
): Promise<{ status: number; body: Record<string, unknown> }> {
  const repo = url.searchParams.get('repo') ?? ''
  const parsed = parseGitHubRepo(repo)
  if (!parsed) {
    return { status: 400, body: { error: 'invalid_request', reason: 'not_github' } }
  }
  const result = await repoAccess(deps, caller.accountId, repo)
  const body: Record<string, unknown> = { access: result.access, owner: parsed.owner, repo: canonicalRepoUrl(parsed) }
  // Only while the App isn't installed for this owner: that is when the desktop picks "Install" vs "ask an owner".
  const askCanInstall = result.access === 'missing' || (result.access === 'public' && result.installationId === null)
  const [install, canInstall] = await Promise.all([
    result.access === 'missing' && deps.connect
      ? repoInstallUrl(deps, caller, repo, {
          setupSessionId: url.searchParams.get('session') ?? undefined,
          repoId: positiveInt(url.searchParams.get('repoId')),
          ownerId: positiveInt(url.searchParams.get('ownerId'))
        })
      : null,
    askCanInstall ? canInstallOn(deps, caller, parsed.owner) : undefined
  ])
  if (install) {
    body.installUrl = install.url
  }
  if (canInstall !== undefined) {
    body.canInstall = canInstall
  }
  return { status: 200, body }
}

const CAN_INSTALL_TIMEOUT_MS = 3_000

/**
 * Can the caller install the App on `owner`? Their own GitHub account (case-insensitive login match),
 * or an org where their membership is active + admin. A repo admin who isn't an org owner is false:
 * GitHub turns their install into a request. Never throws: anything unknown is null.
 */
export async function canInstallOn(
  deps: Pick<RepoAccessDeps, 'fetch' | 'githubUser'>,
  caller: { accountId: string; userId: string },
  owner: string
): Promise<boolean | null> {
  try {
    const user = deps.githubUser ? await deps.githubUser(caller) : null
    if (!user) {
      return null
    }
    if (user.login.toLowerCase() === owner.toLowerCase()) {
      return true
    }
    // A user-owned repo of someone else answers 404 here like a non-member org, so no owner-type read is needed.
    const response = await deps.fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(owner)}`, {
      headers: {
        authorization: `Bearer ${user.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'orca-sandbox-control'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(CAN_INSTALL_TIMEOUT_MS)
    })
    if (response.status === 404 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') !== '0')) {
      return false
    }
    if (!response.ok) {
      return null
    }
    const membership = (await response.json().catch(() => null)) as { state?: unknown; role?: unknown } | null
    if (typeof membership?.state !== 'string' || typeof membership.role !== 'string') {
      return null
    }
    return membership.state === 'active' && membership.role === 'admin'
  } catch {
    return null
  }
}

function positiveInt(value: string | null): number | undefined {
  const n = Number(value ?? NaN)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

// ---- repositories the account's installations reach (N12) ----

export type ListedRepository = GitHubListedRepo & { url: string; installationId: number; owner: string }

const PAGE = 100

/**
 * Cursor `<installationIndex>.<page>` walks the account's bound installations in bind order, one
 * GitHub page (100) at a time. A cursor naming an installation that's no longer bound restarts there.
 */
export async function listAccountRepositories(
  deps: Pick<RepoAccessDeps, 'db' | 'github'>,
  accountId: string,
  cursor: string | null
): Promise<{ repositories: ListedRepository[]; nextCursor: string | null }> {
  if (!deps.github?.listInstallationRepositories) {
    throw new RepoAccessError('not_configured')
  }
  const installations = await listAccountInstallations(deps.db, accountId)
  const match = /^(\d{1,3})\.(\d{1,4})$/.exec(cursor ?? '')
  let index = match ? Number(match[1]) : 0
  const page = match ? Number(match[2]) : 1
  const installation = installations[index]
  if (!installation) {
    return { repositories: [], nextCursor: null }
  }
  const listed = await deps.github.listInstallationRepositories(installation.installation_id, page)
  const repositories = listed.repositories.map((r) => ({
    ...r,
    url: `https://github.com/${r.fullName}`,
    owner: r.fullName.split('/')[0] ?? installation.github_account_login,
    installationId: installation.installation_id
  }))
  let nextCursor: string | null = null
  if (page * PAGE < listed.totalCount && listed.repositories.length === PAGE) {
    nextCursor = `${index}.${page + 1}`
  } else if (++index < installations.length) {
    nextCursor = `${index}.1`
  }
  return { repositories, nextCursor }
}

// ---- billing's setup session ----

export type SetupNotice = { sessionId?: string; accountId: string; repo: string; state: 'done' | 'pending' }
export type SetupNotifier = (notice: SetupNotice) => Promise<void>

/** Billing's trial abuse keys: a team's trial is revoked when another team's trial used this GitHub identity. */
export type TrialGitHubNotice = { accountId: string; githubUserId?: number; githubOwnerId?: number }
export type TrialGitHubNotifier = (notice: TrialGitHubNotice) => Promise<void>

/** Best effort: the desktop also polls repo-access, so a lost notice only costs a poll interval. */
export function billingSetupNotifier(config: { billingUrl?: string; token?: string; fetch: typeof fetch }): SetupNotifier {
  return (notice) => postBilling(config, '/v1/internal/cloud-setup/github', notice, 'cloud_setup_github_notice')
}

/** POST /v1/internal/trial/github after a bind. Best effort: never blocks the bind; 404 (older billing) is harmless. */
export function billingTrialNotifier(config: { billingUrl?: string; token?: string; fetch: typeof fetch }): TrialGitHubNotifier {
  return (notice) => postBilling(config, '/v1/internal/trial/github', notice, 'trial_github_notice')
}

async function postBilling(
  config: { billingUrl?: string; token?: string; fetch: typeof fetch },
  path: string,
  body: unknown,
  event: string
): Promise<void> {
  if (!config.billingUrl || !config.token) {
    return
  }
  try {
    const response = await config.fetch(new URL(path, config.billingUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000)
    })
    console.log(JSON.stringify({ event, status: response.status }))
  } catch (error) {
    console.log(JSON.stringify({ event: `${event}_failed`, error: String(error).slice(0, 120) }))
  }
}

// ---- installation webhooks (every GitHub App receives these; nothing to subscribe) ----

type InstallationPayload = {
  action?: string
  installation?: { id?: number; account?: { id?: number; login?: string; type?: string } }
  requester?: { id?: number } | null
  repository_selection?: string
  repositories?: { full_name?: string }[]
  repositories_added?: { full_name?: string }[]
}

/**
 * `installation.created` with a requester binds the approved request; `installation.deleted` revokes
 * every binding; `installation_repositories.added` tells waiting setup sessions their repo is in.
 */
export async function handleInstallationEvent(
  deps: { db: D1Database; now: number; notify: SetupNotifier; notifyTrial?: TrialGitHubNotifier },
  eventName: string,
  payload: InstallationPayload
): Promise<{ handled: string; bound?: number; revoked?: number; notified?: number }> {
  const installation = payload.installation
  const id = installation?.id
  if (!id || !Number.isSafeInteger(id)) {
    return { handled: 'ignored' }
  }
  if (eventName === 'installation' && payload.action === 'deleted') {
    return { handled: 'deleted', revoked: await revokeInstallation(deps.db, id, null, deps.now) }
  }
  if (eventName === 'installation' && payload.action === 'created') {
    const account = installation?.account
    const requesterId = payload.requester?.id
    if (!requesterId || !account?.login || typeof account.id !== 'number' || (account.type !== 'User' && account.type !== 'Organization')) {
      // A direct install by an owner binds through the setup URL's OAuth round trip instead.
      return { handled: 'created' }
    }
    const resolved = await bindApprovedRequests(
      deps.db,
      { id, account: { id: account.id, login: account.login, type: account.type } },
      requesterId,
      deps.now
    )
    for (const accountId of new Set(resolved.map((r) => r.account_id))) {
      await deps.notifyTrial?.({ accountId, githubUserId: requesterId, githubOwnerId: account.id })
    }
    const covered = new Set((payload.repositories ?? []).map((r) => r.full_name?.toLowerCase()).filter(Boolean))
    let notified = 0
    for (const request of resolved) {
      const parsed = request.repo_url ? parseGitHubRepo(request.repo_url) : null
      if (parsed && (payload.repository_selection === 'all' || covered.has(`${parsed.owner}/${parsed.repo}`.toLowerCase()))) {
        await deps.notify({ ...(request.setup_session_id ? { sessionId: request.setup_session_id } : {}), accountId: request.account_id, repo: canonicalRepoUrl(parsed), state: 'done' })
        notified++
      }
    }
    console.log(JSON.stringify({ event: 'github_install_request_approved', bound: resolved.length }))
    return { handled: 'created', bound: resolved.length, notified }
  }
  if (eventName === 'installation_repositories' && payload.action === 'added') {
    const accounts = await boundAccounts(deps.db, id)
    const added = (payload.repositories_added ?? []).flatMap((r) => (r.full_name && parseGitHubRepo(`https://github.com/${r.full_name}`) ? [r.full_name] : []))
    let notified = 0
    for (const accountId of accounts) {
      for (const fullName of added.slice(0, 20)) {
        await deps.notify({ accountId, repo: `https://github.com/${fullName}`, state: 'done' })
        notified++
      }
    }
    return { handled: 'repositories_added', notified }
  }
  return { handled: 'ignored' }
}

/** After the setup/callback round trip: what to tell billing about the repo the install was for. */
export async function noticeAfterReturn(
  deps: RepoAccessDeps,
  state: { a: string; s?: string; r?: string },
  requested: boolean
): Promise<SetupNotice | null> {
  if (!state.r) {
    return null
  }
  const repo = `https://github.com/${state.r}`
  const base = { ...(state.s ? { sessionId: state.s } : {}), accountId: state.a, repo }
  if (requested) {
    return { ...base, state: 'pending' }
  }
  const { access } = await repoAccess(deps, state.a, repo)
  return access === 'granted' || access === 'public' ? { ...base, state: 'done' } : null
}
