// Share links: a URL for one port inside a workspace VM, public ("anyone with the link") or team-only,
// with an owner-picked expiry. Desktop routes (Orca JWT):
//   POST   /v1/sandboxes/:id/shares {port, audience, expiresIn, allowWake} -> {share}
//   GET    /v1/sandboxes/:id/shares                                       -> {shares}
//   DELETE /v1/sandboxes/:id/shares/:shareId                              -> {share}
//   POST   /v1/shares/:token/visit -> {url}  (team-only: a one-time sign-in URL for this viewer)
// The public side is src/share-gateway.ts.
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import type { Env } from './env'
import { newShareId, openClaims, sealClaims, ticketFor, verifyTicket, type ShareSecrets } from './share-crypto'
import { getSandbox, type SandboxRow } from './store'
import { DESKTOP_PORT, SHARE_PROXY_PORT, ORCAD_PORT } from './sandbox-vm-commands'

export type ShareAudience = 'public' | 'team'
export type ShareState = 'active' | 'expired' | 'revoked'

export type ShareLinkRow = {
  id: string
  sandbox_id: string
  account_id: string
  created_by: string
  port: number
  audience: ShareAudience
  allow_wake: number
  created_at: number
  expires_at: number
  revoked_at: number | null
  last_wake_at: number | null
}

const HOUR_MS = 3_600_000
export const SHARE_EXPIRY_MS = { '1h': HOUR_MS, '24h': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS } as const
export const MAX_ACTIVE_SHARES_PER_SANDBOX = 20
/** Never shareable: in-VM sshd, orcad and the share proxy (the proxy refuses them too). */
export const SHARE_RESERVED_PORTS: readonly number[] = [2222, ORCAD_PORT, SHARE_PROXY_PORT, DESKTOP_PORT]
/** Visitor wakes per workspace per day, across all its links; the owner's own wakes don't count. */
export const MAX_SHARE_WAKES_PER_DAY = 20
/** Ended links stay listed (greyed) this long so the owner sees what just stopped working. */
const LIST_ENDED_FOR_MS = 24 * HOUR_MS
/** One-time team sign-in code lifetime, and the viewer cookie it buys. */
const ENTER_CODE_MS = 60_000
export const VIEWER_SESSION_MS = 12 * HOUR_MS

export const CreateShareSchema = z
  .object({
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((port) => !SHARE_RESERVED_PORTS.includes(port), 'reserved_port'),
    audience: z.enum(['public', 'team']),
    expiresIn: z.enum(['1h', '24h', '7d']),
    allowWake: z.boolean().default(false)
  })
  .strict()

export function shareSecret(env: Env): string | undefined {
  return env.SHARE_LINK_SECRET && env.SHARE_LINK_SECRET.length >= 32 ? env.SHARE_LINK_SECRET : undefined
}

/** Current secret, then SHARE_LINK_SECRET_PREVIOUS while a rotation drains; null when unset. */
export function shareSecrets(env: Env): string[] | null {
  const current = shareSecret(env)
  if (!current) {
    return null
  }
  const previous = env.SHARE_LINK_SECRET_PREVIOUS
  return previous && previous.length >= 32 && previous !== current ? [current, previous] : [current]
}

/**
 * `/s/<token>/` on the control plane's own origin. Every link then shares one origin with each other
 * and with control-plane pages, so it is dev-only unless explicitly enabled; production serves links
 * from SHARE_HOST_SUFFIX (a separate registrable domain).
 */
export function sharePathMode(env: Env): boolean {
  return env.SHARE_PATH_MODE === 'on' || (env.SHARE_PATH_MODE !== 'off' && env.SANDBOX_ENV !== 'prod')
}

export function shareState(link: ShareLinkRow, now: number): ShareState {
  if (link.revoked_at !== null) {
    return 'revoked'
  }
  return now >= link.expires_at ? 'expired' : 'active'
}

/** Who is looking: a desktop caller (JWT) or a browser viewer (team sign-in cookie). */
export type Viewer = { userId: string; accountId: string; orgId?: string }

/**
 * Team membership seam. Today the owning account *is* the team: `org:<id>` (or `dev:org:<id>`)
 * sandboxes are visible to every member of that org, `user:<id>` sandboxes only to their owner.
 * TODO(W4): replace with the org registry (membership, per-workspace visibility, removed members).
 */
export type TeamDirectory = {
  isMember(viewer: Viewer, accountId: string): Promise<boolean>
}

export const ACCOUNT_TEAM_DIRECTORY: TeamDirectory = {
  async isMember(viewer, accountId) {
    return viewer.accountId === accountId
  }
}

/** Owner always; team-only links also admit members of the owning account's team. */
export async function canView(
  viewer: Viewer | null,
  sandbox: Pick<SandboxRow, 'account_id' | 'user_id'>,
  link: Pick<ShareLinkRow, 'audience'>,
  directory: TeamDirectory = ACCOUNT_TEAM_DIRECTORY
): Promise<boolean> {
  if (link.audience === 'public') {
    return true
  }
  if (!viewer) {
    return false
  }
  if (viewer.userId === sandbox.user_id && viewer.accountId === sandbox.account_id) {
    return true
  }
  return directory.isMember(viewer, sandbox.account_id)
}

export async function insertShareLink(
  db: D1Database,
  link: Omit<ShareLinkRow, 'revoked_at' | 'last_wake_at'>
): Promise<ShareLinkRow> {
  await db
    .prepare(
      `INSERT INTO share_links (id, sandbox_id, account_id, created_by, port, audience, allow_wake, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(link.id, link.sandbox_id, link.account_id, link.created_by, link.port, link.audience, link.allow_wake, link.created_at, link.expires_at)
    .run()
  return { ...link, revoked_at: null, last_wake_at: null }
}

export function getShareLink(db: D1Database, id: string): Promise<ShareLinkRow | null> {
  return db.prepare('SELECT * FROM share_links WHERE id = ?').bind(id).first<ShareLinkRow>()
}

export async function listShareLinks(db: D1Database, sandboxId: string, now: number): Promise<ShareLinkRow[]> {
  const since = now - LIST_ENDED_FOR_MS
  const { results } = await db
    .prepare(
      `SELECT * FROM share_links WHERE sandbox_id = ? AND expires_at > ? AND (revoked_at IS NULL OR revoked_at > ?)
       ORDER BY created_at DESC LIMIT 100`
    )
    .bind(sandboxId, since, since)
    .all<ShareLinkRow>()
  return results
}

async function countActive(db: D1Database, sandboxId: string, now: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM share_links WHERE sandbox_id = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(sandboxId, now)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function revokeShareLink(db: D1Database, link: ShareLinkRow, now: number): Promise<ShareLinkRow> {
  if (link.revoked_at !== null) {
    return link
  }
  await db.prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now, link.id).run()
  return (await getShareLink(db, link.id)) ?? { ...link, revoked_at: now }
}

/** Every link of a destroyed workspace stops at once (its URLs would only show "gone"). */
export async function revokeSandboxShares(db: D1Database, sandboxId: string, now: number): Promise<void> {
  await db.prepare('UPDATE share_links SET revoked_at = ? WHERE sandbox_id = ? AND revoked_at IS NULL').bind(now, sandboxId).run()
}

/** One visitor wake per link per `windowMs`: a compare-and-set on last_wake_at. */
/**
 * One visitor wake per link per `windowMs` (compare-and-set on last_wake_at), and at most
 * MAX_SHARE_WAKES_PER_DAY per workspace, so a public link can't keep a VM running on the owner's bill.
 */
export async function claimShareWake(db: D1Database, link: ShareLinkRow, now: number, windowMs: number): Promise<'ok' | 'too_soon' | 'daily_limit'> {
  const today = await db
    .prepare('SELECT COUNT(*) AS n FROM share_wakes WHERE sandbox_id = ? AND at > ?')
    .bind(link.sandbox_id, now - 24 * HOUR_MS)
    .first<{ n: number }>()
  if ((today?.n ?? 0) >= MAX_SHARE_WAKES_PER_DAY) {
    return 'daily_limit'
  }
  const result = await db
    .prepare('UPDATE share_links SET last_wake_at = ? WHERE id = ? AND (last_wake_at IS NULL OR last_wake_at <= ?)')
    .bind(now, link.id, now - windowMs)
    .run()
  if (result.meta.changes !== 1) {
    return 'too_soon'
  }
  await db.batch([
    db.prepare('INSERT INTO share_wakes (sandbox_id, share_id, at) VALUES (?, ?, ?)').bind(link.sandbox_id, link.id, now),
    db.prepare('DELETE FROM share_wakes WHERE at < ?').bind(now - 2 * 24 * HOUR_MS)
  ])
  return 'ok'
}

/** The link's public URL: per-link subdomain when configured, else `/s/<token>/` on this origin. */
export function shareUrl(origin: string, token: string, hostSuffix?: string): string {
  if (hostSuffix) {
    return `https://${token}${hostSuffix}/`
  }
  return `${origin}/s/${token}/`
}

export async function shareView(link: ShareLinkRow, secret: string, origin: string, now: number, hostSuffix?: string) {
  return {
    id: link.id,
    sandboxId: link.sandbox_id,
    port: link.port,
    audience: link.audience,
    allowWake: link.allow_wake === 1,
    url: shareUrl(origin, await ticketFor(secret, link.id), hostSuffix),
    state: shareState(link, now),
    createdBy: link.created_by,
    createdAt: link.created_at,
    expiresAt: link.expires_at,
    revokedAt: link.revoked_at
  }
}

/** One-time code that turns a desktop viewer into a browser viewer for one link (60s, link-bound). */
export function mintEnterCode(secret: string, linkId: string, viewer: Viewer, now: number): Promise<string> {
  return sealClaims(secret, 'enter', {
    sid: linkId,
    sub: viewer.userId,
    acct: viewer.accountId,
    org: viewer.orgId,
    nonce: newShareId(),
    exp: now + ENTER_CODE_MS
  })
}

/** Single use: the code's nonce is recorded on redemption, so a leaked URL can't be replayed. */
export async function redeemEnterCode(db: D1Database, secrets: ShareSecrets, linkId: string, code: string, now: number): Promise<Viewer | null> {
  const claims = await openClaims<{ sid: string; sub: string; acct: string; org?: string; nonce: string; exp: number }>(secrets, 'enter', code, now)
  if (!claims || claims.sid !== linkId || typeof claims.sub !== 'string' || typeof claims.acct !== 'string' || typeof claims.nonce !== 'string') {
    return null
  }
  const used = await db.prepare('INSERT OR IGNORE INTO share_enter_codes (nonce, used_at) VALUES (?, ?)').bind(claims.nonce, now).run()
  if (used.meta.changes !== 1) {
    return null
  }
  // Codes live 60s; older nonces can never verify again, so they're safe to drop.
  await db.prepare('DELETE FROM share_enter_codes WHERE used_at < ?').bind(now - 10 * ENTER_CODE_MS).run()
  return { userId: claims.sub, accountId: claims.acct, ...(typeof claims.org === 'string' ? { orgId: claims.org } : {}) }
}

/** A viewer session is good for one link only, so it can't be replayed against another share. */
export function sealViewer(secret: string, viewer: Viewer, now: number, linkId: string): Promise<string> {
  return sealClaims(secret, 'viewer', { sid: linkId, sub: viewer.userId, acct: viewer.accountId, org: viewer.orgId, exp: now + VIEWER_SESSION_MS })
}

export async function openViewer(secrets: ShareSecrets, sealed: string | undefined, now: number, linkId: string): Promise<Viewer | null> {
  if (!sealed) {
    return null
  }
  const claims = await openClaims<{ sid: string; sub: string; acct: string; org?: string; exp: number }>(secrets, 'viewer', sealed, now)
  if (!claims || claims.sid !== linkId || typeof claims.sub !== 'string' || typeof claims.acct !== 'string') {
    return null
  }
  return { userId: claims.sub, accountId: claims.acct, ...(typeof claims.org === 'string' ? { orgId: claims.org } : {}) }
}

export type ShareRouteContext = {
  db: D1Database
  /** Mints links and codes. */
  secret: string
  /** Accepted when verifying: the current secret, then a retired one during rotation. */
  secrets: ShareSecrets
  caller: SandboxCaller
  now: number
  origin: string
  hostSuffix?: string
  directory?: TeamDirectory
  readJson: () => Promise<unknown>
  /** Drops the gateway's cached copy so a revoke applies at once on this isolate. */
  forget: (linkId: string) => void
}

type RouteAnswer = { status: number; body: unknown }

const notFound: RouteAnswer = { status: 404, body: { error: 'not_found' } }

/** Desktop share routes; null when `pathname` is not one of them. */
export async function handleShareRoute(method: string, pathname: string, ctx: ShareRouteContext): Promise<RouteAnswer | null> {
  const visit = /^\/v1\/shares\/([0-9a-f]{52})\/visit$/.exec(pathname)
  if (visit) {
    if (method !== 'POST') {
      return notFound
    }
    const id = await verifyTicket(ctx.secrets, visit[1]!)
    const link = id ? await getShareLink(ctx.db, id) : null
    const sandbox = link ? await getSandbox(ctx.db, link.sandbox_id) : null
    if (!link || !sandbox || shareState(link, ctx.now) !== 'active') {
      return notFound
    }
    if (!(await canView(ctx.caller, sandbox, link, ctx.directory))) {
      return { status: 403, body: { error: 'forbidden', reason: 'not_in_team' } }
    }
    const url = shareUrl(ctx.origin, visit[1]!, ctx.hostSuffix)
    if (link.audience === 'public') {
      return { status: 200, body: { url } }
    }
    const code = await mintEnterCode(ctx.secret, link.id, ctx.caller, ctx.now)
    return { status: 200, body: { url: `${url}__orca/enter?code=${encodeURIComponent(code)}` } }
  }
  const match = /^\/v1\/sandboxes\/([A-Za-z0-9_]+)\/shares(?:\/([0-9a-f]{32}))?$/.exec(pathname)
  if (!match) {
    return null
  }
  const [, sandboxId, shareId] = match
  const sandbox = await getSandbox(ctx.db, sandboxId!)
  // Another account's sandbox is indistinguishable from a missing one.
  if (!sandbox || sandbox.account_id !== ctx.caller.accountId || sandbox.status === 'destroyed') {
    return notFound
  }
  // Workspaces are their creator's (W4/W5 access rule): only the owner shares one or sees its links;
  // an org admin may also see and turn off its links.
  const owner = sandbox.user_id === ctx.caller.userId
  const orgAdmin = ctx.caller.orgId !== undefined && (ctx.caller.orgRole === 'owner' || ctx.caller.orgRole === 'admin')
  if (!owner && !(orgAdmin && (method === 'GET' || (shareId && method === 'DELETE')))) {
    return notFound
  }
  const view = (link: ShareLinkRow) => shareView(link, ctx.secret, ctx.origin, ctx.now, ctx.hostSuffix)
  if (!shareId && method === 'GET') {
    const links = await listShareLinks(ctx.db, sandbox.id, ctx.now)
    return { status: 200, body: { shares: await Promise.all(links.map(view)) } }
  }
  if (!shareId && method === 'POST') {
    const parsed = CreateShareSchema.safeParse(await ctx.readJson())
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid_request' } }
    }
    if ((await countActive(ctx.db, sandbox.id, ctx.now)) >= MAX_ACTIVE_SHARES_PER_SANDBOX) {
      return { status: 409, body: { error: 'conflict', reason: 'share_limit' } }
    }
    const link = await insertShareLink(ctx.db, {
      id: newShareId(),
      sandbox_id: sandbox.id,
      account_id: sandbox.account_id,
      created_by: ctx.caller.userId,
      port: parsed.data.port,
      audience: parsed.data.audience,
      allow_wake: parsed.data.allowWake ? 1 : 0,
      created_at: ctx.now,
      expires_at: ctx.now + SHARE_EXPIRY_MS[parsed.data.expiresIn]
    })
    console.log(JSON.stringify({ event: 'share_created', sandboxId: sandbox.id, audience: link.audience, expiresIn: parsed.data.expiresIn }))
    return { status: 200, body: { share: await view(link) } }
  }
  if (shareId && method === 'DELETE') {
    const link = await getShareLink(ctx.db, shareId)
    if (!link || link.sandbox_id !== sandbox.id) {
      return notFound
    }
    const revoked = await revokeShareLink(ctx.db, link, ctx.now)
    ctx.forget(link.id)
    console.log(JSON.stringify({ event: 'share_revoked', sandboxId: sandbox.id }))
    return { status: 200, body: { share: await view(revoked) } }
  }
  return notFound
}
