// Org URL slugs for workspace links (orca://cloud/<slug>/W-123).
//   GET /v1/team/org?name=<org display name>  -> {slug, orgId}; the first call names it from `name`
//   PUT /v1/team/org {slug}                    org owner/admin renames it (409 when another org has it)
// Auth owns orgs and knows their names; this Worker only sees ids. So the first member to ask
// proposes a slug from the name their client shows, and the Worker makes it unique. Personal
// accounts have no slug: their links keep the sandbox id form (orca://cloud/w/<sbx>).
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import { WorkspaceError, isOrgAdmin } from './workspaces'

/** Path words a slug can't take: they'd read as a different link form. */
const RESERVED = new Set(['w', 'c', 'me', 'api', 'app', 'new', 'org', 'team', 'settings', 'cloud', 'orca', 'admin', 'help', 'setup'])

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export function isValidSlug(value: string): boolean {
  return SLUG.test(value) && !value.includes('--') && !RESERVED.has(value)
}

/** "Acme Labs, Inc." → "acme-labs-inc"; falls back to "team" when nothing usable is left. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return base.length >= 2 && !RESERVED.has(base) ? base : base ? `${base}-team` : 'team'
}

type Row = { account_id: string; slug: string }

/** `org:abc` / `dev:org:abc` → `abc` (the id the desktop's org list uses). */
export function orgIdOf(accountId: string): string | null {
  const match = /^(?:dev:)?org:(.+)$/.exec(accountId)
  return match ? match[1]! : null
}

export async function slugForAccount(db: D1Database, accountId: string): Promise<string | null> {
  const row = await db.prepare('SELECT slug FROM org_slugs WHERE account_id = ?').bind(accountId).first<{ slug: string }>()
  return row?.slug ?? null
}

export async function accountForSlug(db: D1Database, slug: string): Promise<string | null> {
  if (!isValidSlug(slug)) {
    return null
  }
  const row = await db.prepare('SELECT account_id FROM org_slugs WHERE slug = ?').bind(slug).first<Row>()
  return row?.account_id ?? null
}

const NameQuery = z.string().trim().min(1).max(120)

export async function getOrgSlug(db: D1Database, caller: SandboxCaller, url: URL, now: number) {
  const orgId = caller.orgId ? orgIdOf(caller.accountId) : null
  if (!orgId) {
    return { slug: null, orgId: null }
  }
  const existing = await slugForAccount(db, caller.accountId)
  if (existing) {
    return { slug: existing, orgId }
  }
  const name = NameQuery.safeParse(url.searchParams.get('name') ?? '')
  if (!name.success) {
    // Nothing to name it from yet; the next client that knows the org's name will.
    return { slug: null, orgId }
  }
  const base = slugify(name.data)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 32)}-${attempt + 1}`
    const result = await db
      .prepare('INSERT OR IGNORE INTO org_slugs (account_id, slug, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(caller.accountId, candidate, now, caller.userId, now)
      .run()
    if (result.meta.changes === 1) {
      return { slug: candidate, orgId }
    }
    // Either another org holds this slug, or a teammate just named ours (then use theirs).
    const raced = await slugForAccount(db, caller.accountId)
    if (raced) {
      return { slug: raced, orgId }
    }
  }
  throw new WorkspaceError('conflict', 'slug_exhausted')
}

const PutSchema = z.object({ slug: z.string().min(1).max(40) }).strict()

export async function putOrgSlug(db: D1Database, caller: SandboxCaller, body: unknown, now: number) {
  const orgId = caller.orgId ? orgIdOf(caller.accountId) : null
  if (!orgId) {
    throw new WorkspaceError('invalid_request', 'personal_account')
  }
  if (!isOrgAdmin(caller)) {
    throw new WorkspaceError('forbidden', 'admin_only')
  }
  const parsed = PutSchema.safeParse(body)
  if (!parsed.success || !isValidSlug(parsed.data.slug)) {
    throw new WorkspaceError('invalid_request', 'invalid_slug')
  }
  const slug = parsed.data.slug
  const holder = await accountForSlug(db, slug)
  if (holder && holder !== caller.accountId) {
    throw new WorkspaceError('conflict', 'slug_taken')
  }
  await db
    .prepare(
      `INSERT INTO org_slugs (account_id, slug, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id) DO UPDATE SET slug = excluded.slug, updated_at = excluded.updated_at`
    )
    .bind(caller.accountId, slug, now, caller.userId, now)
    .run()
    .catch((error: unknown) => {
      // The UNIQUE index lost a race with another org claiming the same slug.
      if (String(error).includes('UNIQUE')) {
        throw new WorkspaceError('conflict', 'slug_taken')
      }
      throw error
    })
  return { slug, orgId }
}
