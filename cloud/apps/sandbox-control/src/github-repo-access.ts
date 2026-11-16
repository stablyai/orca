// Can Orca Cloud clone this repository for this account, and if not, what fixes it? Checked when
// Orca Cloud is picked (cloud-start onboarding), never after a build fails.
//   GET /v1/github/repo-access?repo=<https github url>[&session=cs_…][&repoId=&ownerId=]
//        -> {access:'public'|'granted'|'missing'|'requested', owner, installUrl?, canInstall?}
//      canInstall (only when the App isn't installed for the owner: 'missing', or 'public' with no
//      installation): true = the caller can install it on the owner (it is their own GitHub account, or
//      they are an active admin of the owner org); false = another user's account, or a non-admin org
//      membership; null = unknown (no connected GitHub user token, membership unreadable, GitHub down).
//      push: can a workspace on this repo push? 'ok' = granted; 'not_installed' = the
//      App isn't on the owner; 'repo_not_selected' = it is, but this repository isn't one it selected
//      (configureUrl: the installation's settings page); 'not_connected' = the App reaches the repo
//      but through an installation this Orca account isn't bound to. installUrl is present for every
//      push reason but 'ok' and 'repo_not_selected', public repositories included.
//      GitHub's installation lookups are cached in D1 (github-installation-cache.ts).
//   GET /v1/github/repositories[?cursor=]  -> {repositories, nextCursor}   (start from GitHub)
//   GET /v1/internal/github/install-url?accountId&userId&repo&session  (billing's setup chain,
//        Bearer CONTROL_PLANE_TOKEN) -> {access, url}
// `granted` means the same test the lifecycle applies before a create: the App's installation covers
// the repo and is bound to the caller's account. `requested` means a member who isn't an owner of
// the org on GitHub asked an owner to approve the App; the installation webhook finishes it.
// Billing's setup session (cloud-setup.ts) is told about each change, so a waiting desktop starts on
// its own: POST <billing>/v1/internal/cloud-setup/github {sessionId?, accountId, repo, state}.
import type { GitHubAppMinter, GitHubListedRepo } from './github-app'
import { parseGitHubRepo } from './github-app'
import { cachedOwnerInstallation, cachedRepoInstallation, forgetInstallation, forgetOwner } from './github-installation-cache'
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

/** Whether a workspace on the repository can push, and if not, what's missing (the create wizard's GitHub access step). */
export type PushAccess = 'ok' | 'not_installed' | 'repo_not_selected' | 'not_connected'

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
  const { access, owner, installationId } = await repoAccessWithPush(deps, accountId, repoUrl)
  return { access, owner, installationId }
}

/** repoAccess plus whether a workspace can push, and the owner installation when that's the gap. */
export async function repoAccessWithPush(
  deps: RepoAccessDeps,
  accountId: string,
  repoUrl: string
): Promise<{
  access: RepoAccess
  owner: string
  installationId: number | null
  push: PushAccess
  ownerInstallation?: { id: number; type: 'User' | 'Organization' }
}> {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) {
    throw new RepoAccessError('not_github')
  }
  const installation = deps.github ? await cachedRepoInstallation(deps.db, deps.github, parsed, deps.now) : null
  if (installation && (await isInstallationBound(deps.db, installation.id, accountId))) {
    return { access: 'granted', owner: parsed.owner, installationId: installation.id, push: 'ok' }
  }
  const [gap, isPublic] = await Promise.all([pushGap(deps, accountId, parsed.owner, installation), deps.publicRepoCheck(repoUrl)])
  if (isPublic) {
    return { access: 'public', owner: parsed.owner, installationId: installation?.id ?? null, ...gap }
  }
  if (!installation && (await openInstallRequest(deps.db, accountId, parsed.owner, deps.now))) {
    // Ours, and still open on GitHub (an owner who declines leaves no webhook, only an empty list).
    const pending = await deps.github?.pendingRequestOwners?.().catch(() => null)
    if (!pending || pending.has(parsed.owner.toLowerCase())) {
      return { access: 'requested', owner: parsed.owner, installationId: null, ...gap }
    }
  }
  return { access: 'missing', owner: parsed.owner, installationId: installation?.id ?? null, ...gap }
}

/**
 * Not granted: the App reaches the repo through someone else's binding, or it's on the owner without
 * this repository, or it isn't on the owner. Only an installation bound to this account counts as
 * "repo not selected" without asking GitHub; otherwise one cached owner lookup tells.
 */
async function pushGap(
  deps: RepoAccessDeps,
  accountId: string,
  owner: string,
  repoInstallation: { id: number } | null
): Promise<{ push: PushAccess; ownerInstallation?: { id: number; type: 'User' | 'Organization' } }> {
  if (repoInstallation) {
    return { push: 'not_connected' }
  }
  const bound = (await listAccountInstallations(deps.db, accountId)).find(
    (row) => row.github_account_login.toLowerCase() === owner.toLowerCase()
  )
  if (bound) {
    return {
      push: 'repo_not_selected',
      ownerInstallation: { id: bound.installation_id, type: bound.github_account_type === 'User' ? 'User' : 'Organization' }
    }
  }
  // Never holds the answer up: GitHub erroring or slow reads as "not installed", whose install page
  // GitHub turns into the installation's settings when the App is already there.
  const onOwner = deps.github
    ? await withTimeout(cachedOwnerInstallation(deps.db, deps.github, owner, deps.now), OWNER_LOOKUP_TIMEOUT_MS).catch(() => null)
    : null
  if (!onOwner) {
    return { push: 'not_installed' }
  }
  // On the owner, but bound to another Orca account (or none): binding it is the install round trip.
  return (await isInstallationBound(deps.db, onOwner.id, accountId))
    ? { push: 'repo_not_selected', ownerInstallation: { id: onOwner.id, type: onOwner.account.type } }
    : { push: 'not_connected' }
}

const OWNER_LOOKUP_TIMEOUT_MS = 3_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer))
}

/** GitHub's page where the installation's repository selection is changed. */
export function installationSettingsUrl(owner: string, installation: { id: number; type: 'User' | 'Organization' }): string {
  return installation.type === 'User'
    ? `https://github.com/settings/installations/${installation.id}`
    : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/installations/${installation.id}`
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
  const result = await repoAccessWithPush(deps, caller.accountId, repo)
  const body: Record<string, unknown> = { access: result.access, owner: parsed.owner, repo: canonicalRepoUrl(parsed), push: result.push }
  // Only while the App isn't installed for this owner: that is when the desktop picks "Install" vs "ask an owner".
  const askCanInstall = result.access === 'missing' || (result.access === 'public' && result.installationId === null)
  // A public repository clones anonymously but can't push: the wizard's GitHub step installs from here too.
  const wantsInstall = result.access === 'missing' || (result.access === 'public' && (result.push === 'not_installed' || result.push === 'not_connected'))
  if (result.push === 'repo_not_selected' && result.ownerInstallation) {
    body.configureUrl = installationSettingsUrl(parsed.owner, result.ownerInstallation)
  }
  const [install, canInstall] = await Promise.all([
    wantsInstall && deps.connect
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
 * or an org where their membership is active + admin. Another user's account, or an org membership
 * that isn't active admin, is false (a repo admin who isn't an org owner only gets a request on
 * GitHub). Never throws: anything unknown (incl. a 403/404 membership read) is null.
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
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'orca-sandbox-control' }
    // Owner type, anonymously: someone else's personal account is a definite false.
    const ownerResponse = await deps.fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(CAN_INSTALL_TIMEOUT_MS)
    })
    const ownerBody = ownerResponse.ok ? ((await ownerResponse.json().catch(() => null)) as { type?: unknown } | null) : null
    if (ownerBody?.type === 'User') {
      return false
    }
    if (ownerBody?.type !== 'Organization') {
      return null
    }
    // A GitHub App user token often can't read orgs the App isn't installed on (exactly when this
    // field is asked), so 403/404 here means "can't tell", not "not an admin".
    const response = await deps.fetch(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(owner)}`, {
      headers: { ...headers, authorization: `Bearer ${user.token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(CAN_INSTALL_TIMEOUT_MS)
    })
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

// ---- repositories the account's installations reach ----

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
  if (eventName === 'installation' || eventName === 'installation_repositories') {
    // Any install, uninstall, suspend or selection change: repo-access asks GitHub on the next poll.
    await forgetInstallation(deps.db, id)
    if (installation?.account?.login) {
      await forgetOwner(deps.db, installation.account.login)
    }
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
  // Back from GitHub's install page: its webhook may not have landed yet.
  const owner = parseGitHubRepo(repo)?.owner
  if (owner) {
    await forgetOwner(deps.db, owner)
  }
  if (requested) {
    return { ...base, state: 'pending' }
  }
  const { access } = await repoAccess(deps, state.a, repo)
  return access === 'granted' || access === 'public' ? { ...base, state: 'done' } : null
}
