// Teammate profiles and Pokes (Conductor 0.91 parity).
//   GET  /v1/team/members/:userId/profile?utcOffsetMin=<-840..840>
//   POST /v1/team/members/:userId/poke
//   GET  /v1/team/pokes                 the caller's unseen pokes (last 24 h) and their opt-in
//   PUT  /v1/team/pokes/settings {enabled}
//   POST /v1/team/pokes/seen {ids}
// Privacy: a profile shows what a teammate can already see (name, role from the roster, workspaces
// they can open). The 0–4 intensity per day is shared only by people who turned on "Pokes and
// activity" (the same opt-in as Pokes); exact amounts only ever go to the person themself. The
// heatmap counts the member's sandbox time (usage_outbox, attributed to the workspace owner) plus
// model spend their own client reported (member_usage_hours).
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import { memberNamesFor } from './member-names'
import type { SandboxRow } from './store'
import { canSee, COMPUTE_USD_MICROS_PER_HOUR, workspaceViews } from './workspaces'
import {
  POKE_INBOX_TTL_MS,
  POKE_PAIR_COOLDOWN_MS,
  POKE_SENDER_HOURLY_LIMIT,
  TEAMMATE_HEATMAP_DAYS,
  TEAMMATE_RECENT_WORKSPACES,
  type PokeRefusal
} from '../../../../src/shared/cloud-workspaces/team-presence-wire'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export class TeamPresenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: PokeRefusal | string,
    readonly retryAfterMs?: number
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'TeamPresenceError'
  }
}

export const MEMBER_ID = /^[A-Za-z0-9_.:-]{1,128}$/

function isoDate(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10)
}

/** 0 for nothing; otherwise 1–4 relative to the member's own busiest day in the window. */
export function usageLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) {
    return 0
  }
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)))
}

/**
 * Per local day: sandbox time on workspaces the member owns, and model spend they reported. Days
 * are the viewer's calendar days (utcOffsetMin); a segment crossing midnight is split.
 */
export async function memberDailyUsage(
  db: D1Database,
  accountId: string,
  userId: string,
  now: number,
  utcOffsetMin: number,
  days = TEAMMATE_HEATMAP_DAYS
) {
  const offsetMs = utcOffsetMin * 60_000
  const today = Math.floor((now + offsetMs) / DAY_MS)
  const firstDay = today - days + 1
  const windowStart = firstDay * DAY_MS - offsetMs
  const computeMs = new Array<number>(days).fill(0)
  const tokenUsd = new Array<number>(days).fill(0)
  const { results: segments } = await db
    .prepare(
      `SELECT u.started_at, u.ended_at FROM usage_outbox u JOIN sandboxes s ON s.id = u.sandbox_id
       WHERE u.account_id = ? AND u.started_at < ? AND u.ended_at > ? AND s.user_id = ?`
    )
    .bind(accountId, now, windowStart, userId)
    .all<{ started_at: number; ended_at: number }>()
  for (const seg of segments) {
    let from = Math.max(seg.started_at, windowStart)
    const to = Math.min(seg.ended_at, now)
    while (from < to) {
      const day = Math.floor((from + offsetMs) / DAY_MS)
      const dayEnd = (day + 1) * DAY_MS - offsetMs
      const end = Math.min(to, dayEnd)
      const index = day - firstDay
      if (index >= 0 && index < days) {
        computeMs[index]! += end - from
      }
      from = end
    }
  }
  const { results: hours } = await db
    .prepare(
      `SELECT hour, token_usd_micros FROM member_usage_hours WHERE account_id = ? AND user_id = ? AND hour >= ?`
    )
    .bind(accountId, userId, Math.floor(windowStart / HOUR_MS))
    .all<{ hour: number; token_usd_micros: number }>()
  for (const row of hours) {
    const index = Math.floor((row.hour * HOUR_MS + offsetMs) / DAY_MS) - firstDay
    if (index >= 0 && index < days) {
      tokenUsd[index]! += row.token_usd_micros
    }
  }
  const rate = COMPUTE_USD_MICROS_PER_HOUR.standard
  const usdMicros = computeMs.map((ms, i) => Math.round((ms / HOUR_MS) * rate) + tokenUsd[i]!)
  const max = Math.max(0, ...usdMicros)
  return {
    start: isoDate(firstDay),
    levels: usdMicros.map((value) => usageLevel(value, max)),
    activeDays: usdMicros.filter((value) => value > 0).length,
    computeMs,
    usdMicros
  }
}

async function pokesEnabled(db: D1Database, accountId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT enabled FROM member_poke_prefs WHERE account_id = ? AND user_id = ?')
    .bind(accountId, userId)
    .first<{ enabled: number }>()
  return row?.enabled === 1
}

function requireTeam(caller: SandboxCaller): void {
  if (!caller.orgId) {
    throw new TeamPresenceError(400, 'invalid_request', 'personal_account')
  }
}

export type ActivitySharing = 'opt_in' | 'team'

export async function memberProfile(
  db: D1Database,
  caller: SandboxCaller,
  userId: string,
  url: URL,
  now: number,
  activitySharing: ActivitySharing = 'opt_in'
) {
  const self = userId === caller.userId
  if (!self && !caller.orgId) {
    // A personal account has no teammates.
    throw new TeamPresenceError(404, 'not_found')
  }
  const offset = Number(url.searchParams.get('utcOffsetMin') ?? '0')
  const utcOffsetMin = Number.isInteger(offset) && Math.abs(offset) <= 14 * 60 ? offset : 0
  const { results } = await db
    .prepare(
      `SELECT * FROM sandboxes WHERE account_id = ? AND status <> 'destroyed' AND archived_at IS NULL
       AND (user_id = ? OR created_by = ?) ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 100`
    )
    .bind(caller.accountId, userId, userId)
    .all<SandboxRow>()
  // Only workspaces the viewer could already open from Home: a teammate's private ones stay private.
  const rows = results.filter((row) => !row.hidden && canSee(caller, row)).slice(0, TEAMMATE_RECENT_WORKSPACES)
  const [names, recentWorkspaces, mine, theirs] = await Promise.all([
    memberNamesFor(db, caller.accountId, [userId]),
    workspaceViews(db, caller, rows, now),
    caller.orgId ? pokesEnabled(db, caller.accountId, caller.userId) : Promise.resolve(false),
    caller.orgId && !self ? pokesEnabled(db, caller.accountId, userId) : Promise.resolve(false)
  ])
  // Your own heatmap always; a teammate's only when they chose to share it.
  const usage = self || theirs || activitySharing === 'team' ? await memberDailyUsage(db, caller.accountId, userId, now, utcOffsetMin) : null
  return {
    profile: {
      userId,
      self,
      name: names.get(userId) ?? null,
      usage: usage && {
        start: usage.start,
        levels: usage.levels,
        activeDays: usage.activeDays,
        own: self ? { computeMs: usage.computeMs, usdMicros: usage.usdMicros } : null
      },
      recentWorkspaces,
      pokes: { enabled: mine, teammateEnabled: self ? null : theirs }
    }
  }
}

export const PokeSettingsBody = z.object({ enabled: z.boolean() }).strict()
export const PokesSeenBody = z.object({ ids: z.array(z.string().regex(/^pok_[0-9a-f]{24}$/)).min(1).max(50) }).strict()

export async function setPokeSettings(db: D1Database, caller: SandboxCaller, enabled: boolean, now: number) {
  requireTeam(caller)
  const statements = [
    db
      .prepare(
        `INSERT INTO member_poke_prefs (account_id, user_id, enabled, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .bind(caller.accountId, caller.userId, enabled ? 1 : 0, now)
  ]
  if (!enabled) {
    // Turning it off drops anything waiting, so turning it back on doesn't replay old pokes.
    statements.push(
      db
        .prepare('UPDATE member_pokes SET seen_at = ? WHERE account_id = ? AND to_user_id = ? AND seen_at IS NULL')
        .bind(now, caller.accountId, caller.userId)
    )
  }
  await db.batch(statements)
  return { enabled }
}

export async function pokeInbox(db: D1Database, caller: SandboxCaller, now: number) {
  if (!caller.orgId) {
    return { enabled: false, pokes: [] }
  }
  const enabled = await pokesEnabled(db, caller.accountId, caller.userId)
  if (!enabled) {
    return { enabled, pokes: [] }
  }
  const { results } = await db
    .prepare(
      `SELECT id, from_user_id, created_at FROM member_pokes
       WHERE account_id = ? AND to_user_id = ? AND seen_at IS NULL AND created_at > ?
       ORDER BY created_at DESC LIMIT 20`
    )
    .bind(caller.accountId, caller.userId, now - POKE_INBOX_TTL_MS)
    .all<{ id: string; from_user_id: string; created_at: number }>()
  const names = await memberNamesFor(db, caller.accountId, results.map((r) => r.from_user_id))
  return {
    enabled,
    pokes: results.map((r) => ({ id: r.id, fromUserId: r.from_user_id, fromName: names.get(r.from_user_id) ?? null, at: r.created_at }))
  }
}

export async function markPokesSeen(db: D1Database, caller: SandboxCaller, ids: readonly string[], now: number) {
  await db
    .prepare(
      `UPDATE member_pokes SET seen_at = ? WHERE account_id = ? AND to_user_id = ? AND seen_at IS NULL
       AND id IN (${ids.map(() => '?').join(', ')})`
    )
    .bind(now, caller.accountId, caller.userId, ...ids)
    .run()
  return { ok: true as const }
}

function pokeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `pok_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Both people must have Pokes on. The teammate's own opt-in (written with their token in this
 * account, and dropped when they leave it) is also what proves they are a member.
 */
export async function sendPoke(db: D1Database, caller: SandboxCaller, toUserId: string, now: number) {
  requireTeam(caller)
  if (toUserId === caller.userId) {
    throw new TeamPresenceError(400, 'invalid_request', 'self')
  }
  if (!(await pokesEnabled(db, caller.accountId, caller.userId))) {
    throw new TeamPresenceError(409, 'conflict', 'pokes_off')
  }
  if (!(await pokesEnabled(db, caller.accountId, toUserId))) {
    throw new TeamPresenceError(409, 'conflict', 'teammate_pokes_off')
  }
  const recent = await db
    .prepare(
      `SELECT COUNT(*) AS sent, MAX(CASE WHEN to_user_id = ? THEN created_at END) AS last_to_them
       FROM member_pokes WHERE account_id = ? AND from_user_id = ? AND created_at > ?`
    )
    .bind(toUserId, caller.accountId, caller.userId, now - HOUR_MS)
    .first<{ sent: number; last_to_them: number | null }>()
  const lastToThem = recent?.last_to_them ?? null
  if (lastToThem !== null && now - lastToThem < POKE_PAIR_COOLDOWN_MS) {
    throw new TeamPresenceError(429, 'rate_limited', 'poke_cooldown', POKE_PAIR_COOLDOWN_MS - (now - lastToThem))
  }
  if ((recent?.sent ?? 0) >= POKE_SENDER_HOURLY_LIMIT) {
    throw new TeamPresenceError(429, 'rate_limited', 'poke_rate', HOUR_MS)
  }
  const id = pokeId()
  await db.batch([
    db
      .prepare('INSERT INTO member_pokes (id, account_id, from_user_id, to_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, caller.accountId, caller.userId, toUserId, now),
    // Keep the table small: nothing older than a day is ever read.
    db.prepare('DELETE FROM member_pokes WHERE account_id = ? AND created_at < ?').bind(caller.accountId, now - 2 * POKE_INBOX_TTL_MS)
  ])
  return { poke: { id, at: now } }
}

/** A member left: their opt-in and anything waiting for them goes; pokes they sent stop showing. */
export async function forgetMemberPokes(db: D1Database, accountId: string, userId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM member_poke_prefs WHERE account_id = ? AND user_id = ?').bind(accountId, userId),
    db
      .prepare('UPDATE member_pokes SET seen_at = ? WHERE account_id = ? AND (to_user_id = ? OR from_user_id = ?) AND seen_at IS NULL')
      .bind(now, accountId, userId, userId)
  ])
}

/** Routes under /v1/team/members and /v1/team/pokes; null when the path isn't one of them. */
export async function teamPresenceRoute(
  db: D1Database,
  caller: SandboxCaller,
  request: Request,
  url: URL,
  now: number,
  readJson: () => Promise<unknown>,
  options: { activitySharing?: ActivitySharing } = {}
): Promise<unknown | null> {
  const member = /^\/v1\/team\/members\/([^/]+)\/(profile|poke)$/.exec(url.pathname)
  if (member) {
    let userId: string
    try {
      userId = decodeURIComponent(member[1]!)
    } catch {
      throw new TeamPresenceError(400, 'invalid_request')
    }
    if (!MEMBER_ID.test(userId)) {
      throw new TeamPresenceError(400, 'invalid_request')
    }
    if (member[2] === 'profile' && request.method === 'GET') {
      return memberProfile(db, caller, userId, url, now, options.activitySharing)
    }
    if (member[2] === 'poke' && request.method === 'POST') {
      return sendPoke(db, caller, userId, now)
    }
    return null
  }
  if (url.pathname === '/v1/team/pokes' && request.method === 'GET') {
    return pokeInbox(db, caller, now)
  }
  if (url.pathname === '/v1/team/pokes/settings') {
    if (request.method === 'GET') {
      return { enabled: caller.orgId ? await pokesEnabled(db, caller.accountId, caller.userId) : false }
    }
    if (request.method === 'PUT') {
      const body = PokeSettingsBody.safeParse(await readJson())
      if (!body.success) {
        throw new TeamPresenceError(400, 'invalid_request')
      }
      return setPokeSettings(db, caller, body.data.enabled, now)
    }
    return null
  }
  if (url.pathname === '/v1/team/pokes/seen' && request.method === 'POST') {
    const body = PokesSeenBody.safeParse(await readJson())
    if (!body.success) {
      throw new TeamPresenceError(400, 'invalid_request')
    }
    return markPokesSeen(db, caller, body.data.ids, now)
  }
  return null
}
