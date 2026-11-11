// Read a sleeping workspace without waking it (gap 5), end-to-end encrypted:
//   PUT    /v1/reader-keys {publicKeyB64, deviceLabel, deviceKind}  register this device's X25519 key
//   GET    /v1/reader-keys                                         the caller's live keys
//   DELETE /v1/reader-keys/:id
//   GET    /v1/team/workspaces/:id/read-snapshot?keyId=rk_…        the body + only that key's wrapped key
// At every drain the control plane asks the VM (image/vm/orca-sandbox-read-snapshot) to seal a
// compact snapshot to the reader keys allowed to open the workspace, and stores the ciphertext.
// D1, backups and logs hold only ciphertext and never a reader secret. Trust model: like W4 grants,
// the control plane at runtime chooses the recipient keys and drives the VM, so it is trusted not to
// add its own key (same as relaying grant keys). Access mirrors canOpen at read time, and pruning
// (removal, private, revoke) deletes wrapped keys at once, without the VM.
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import { ensureEntryPoints } from './golden-images'
import type { LifecycleDeps } from './lifecycle'
import type { SandboxRow } from './store'
import { WorkspaceError, canOpen, isOwner } from './workspaces'

export const READ_SNAPSHOT_COMMAND = '/opt/orca/bin/orca-sandbox-read-snapshot'
const READ_SNAPSHOT_TIMEOUT_MS = 40_000
/** Above this the VM trims the payload; anything bigger here is refused (D1 rows stay small). */
export const MAX_READ_SNAPSHOT_BYTES = 220_000
/** A sleeping workspace is sealed to at most this many devices (newest first). */
export const MAX_READ_RECIPIENTS = 64
const MAX_KEYS_PER_USER = 12

const B64_32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine((value) => atob(value).length === 32, 'expected 32 bytes')
const B64_NONCE = z.string().regex(/^[A-Za-z0-9+/]{16}$/)
const KEY_ID = /^rk_[0-9a-f]{24}$/
const SNAPSHOT_ID = /^rsn_[0-9a-f]{24}$/

export const ReaderKeyRequestSchema = z
  .object({
    publicKeyB64: B64_32,
    deviceLabel: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f]+$/),
    deviceKind: z.enum(['desktop', 'mobile'])
  })
  .strict()

export type ReaderKeyRow = {
  id: string
  user_id: string
  account_id: string
  dev: number
  public_key: string
  device_kind: string
  device_label: string
  device_session_id: string | null
  created_at: number
  last_seen_at: number
  revoked_at: number | null
  revoked_by: string | null
}

export class ReadSnapshotRouteError extends Error {
  constructor(
    readonly code: 'not_found' | 'no_snapshot' | 'not_sealed_for_key' | 'invalid_request',
    readonly status: number
  ) {
    super(code)
  }
}

function randomHexId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function readerKeyView(row: ReaderKeyRow) {
  return {
    id: row.id,
    deviceKind: row.device_kind,
    deviceLabel: row.device_label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  }
}

/** Idempotent per (caller, public key): the same id comes back and lastSeenAt moves. */
export async function registerReaderKey(
  db: D1Database,
  caller: SandboxCaller,
  body: z.infer<typeof ReaderKeyRequestSchema>,
  now: number
): Promise<ReaderKeyRow> {
  const live = await db
    .prepare('SELECT * FROM reader_keys WHERE account_id = ? AND user_id = ? AND public_key = ? AND revoked_at IS NULL')
    .bind(caller.accountId, caller.userId, body.publicKeyB64)
    .first<ReaderKeyRow>()
  if (live) {
    // A phone's key must stay bound to the session that registered it; another session (or a
    // desktop token) presenting the same public key is refused rather than rebinding it.
    if ((live.device_session_id ?? null) !== (caller.deviceSessionId ?? null)) {
      throw new ReadSnapshotRouteError('invalid_request', 409)
    }
    await db
      .prepare('UPDATE reader_keys SET last_seen_at = ?, device_label = ? WHERE id = ?')
      .bind(now, body.deviceLabel, live.id)
      .run()
    return { ...live, last_seen_at: now, device_label: body.deviceLabel }
  }
  const row: ReaderKeyRow = {
    id: randomHexId('rk'),
    user_id: caller.userId,
    account_id: caller.accountId,
    dev: caller.dev ? 1 : 0,
    public_key: body.publicKeyB64,
    // A phone token is a phone, whatever it claims.
    device_kind: caller.deviceSessionId ? 'mobile' : body.deviceKind,
    device_label: body.deviceLabel,
    device_session_id: caller.deviceSessionId ?? null,
    created_at: now,
    last_seen_at: now,
    revoked_at: null,
    revoked_by: null
  }
  const inserted = await db
    .prepare(
      `INSERT INTO reader_keys (id, user_id, account_id, dev, public_key, device_kind, device_label, device_session_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
    )
    .bind(row.id, row.user_id, row.account_id, row.dev, row.public_key, row.device_kind, row.device_label, row.device_session_id, now, now)
    .run()
  if (inserted.meta.changes === 0) {
    // A concurrent PUT of the same key won the race: answer with its row.
    return registerReaderKey(db, caller, body, now)
  }
  // Bounded per member: the least recently seen keys beyond the cap are retired.
  const { results: stale } = await db
    .prepare(
      `SELECT id FROM reader_keys WHERE account_id = ? AND user_id = ? AND revoked_at IS NULL
       ORDER BY last_seen_at DESC, created_at DESC LIMIT -1 OFFSET ?`
    )
    .bind(caller.accountId, caller.userId, MAX_KEYS_PER_USER)
    .all<{ id: string }>()
  if (stale.length > 0) {
    await revokeReaderKeys(db, stale.map((s) => s.id), 'system:key_limit', now)
  }
  return row
}

/** Revokes the keys and deletes every wrapped snapshot key they had (no VM involved). */
export async function revokeReaderKeys(db: D1Database, ids: readonly string[], by: string, now: number): Promise<number> {
  let revoked = 0
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const marks = chunk.map(() => '?').join(',')
    const [update] = await db.batch([
      db.prepare(`UPDATE reader_keys SET revoked_at = ?, revoked_by = ? WHERE id IN (${marks}) AND revoked_at IS NULL`).bind(now, by, ...chunk),
      db.prepare(`DELETE FROM read_snapshot_keys WHERE key_id IN (${marks})`).bind(...chunk)
    ])
    revoked += update?.meta.changes ?? 0
  }
  return revoked
}

async function revokeWhere(db: D1Database, where: string, binds: (string | number)[], by: string, now: number): Promise<number> {
  const { results } = await db
    .prepare(`SELECT id FROM reader_keys WHERE ${where} AND revoked_at IS NULL`)
    .bind(...binds)
    .all<{ id: string }>()
  return revokeReaderKeys(db, results.map((r) => r.id), by, now)
}

/** A member left the account: none of their devices may read any of its workspaces again. */
export function revokeMemberReaderKeys(db: D1Database, accountId: string, userId: string, now: number): Promise<number> {
  return revokeWhere(db, 'account_id = ? AND user_id = ?', [accountId, userId], 'system:member_removed', now)
}

/** A phone was unpaired or revoked: its reader key goes with it. */
export function revokeDeviceSessionReaderKeys(db: D1Database, deviceSessionId: string, now: number): Promise<number> {
  return revokeWhere(db, 'device_session_id = ?', [deviceSessionId], 'system:device_revoked', now)
}

/**
 * Visibility or owner changed: drop every wrapped key of this workspace whose holder is not its
 * (new) owner. Team members get back in at the next drain if it becomes team-visible again.
 */
export async function pruneReadSnapshotToOwner(db: D1Database, row: SandboxRow): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM read_snapshot_keys WHERE sandbox_id = ? AND key_id NOT IN
         (SELECT id FROM reader_keys WHERE account_id = ? AND user_id = ? AND revoked_at IS NULL)`
    )
    .bind(row.id, row.account_id, row.user_id)
    .run()
  return result.meta.changes
}

export async function deleteReadSnapshot(db: D1Database, sandboxId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM read_snapshot_keys WHERE sandbox_id = ?').bind(sandboxId),
    db.prepare('DELETE FROM read_snapshots WHERE sandbox_id = ?').bind(sandboxId)
  ])
}

/** The live keys allowed to open this workspace right now (owner; every member when team-visible). */
export async function readerKeysFor(db: D1Database, row: SandboxRow, now: number): Promise<{ id: string; public_key: string }[]> {
  if (row.archived_at !== null) {
    return []
  }
  const team = row.visibility === 'team'
  const { results } = await db
    .prepare(
      `SELECT k.id, k.public_key FROM reader_keys k
       LEFT JOIN device_sessions d ON d.id = k.device_session_id
       WHERE k.account_id = ? AND k.revoked_at IS NULL ${team ? '' : 'AND k.user_id = ?'}
         -- A phone key counts only while its device session is live (not revoked, not expired).
         AND (k.device_session_id IS NULL OR (d.revoked_at IS NULL AND d.expires_at > ?))
       ORDER BY (k.user_id = ?) DESC, k.last_seen_at DESC LIMIT ?`
    )
    .bind(...(team ? [row.account_id] : [row.account_id, row.user_id]), now, row.user_id, MAX_READ_RECIPIENTS)
    .all<{ id: string; public_key: string }>()
  return results
}

const VmOutputSchema = z
  .object({
    v: z.literal(1),
    snapshotId: z.string().regex(SNAPSHOT_ID),
    workspaceId: z.string(),
    nonceB64: B64_NONCE,
    ciphertextB64: z.string().regex(/^[A-Za-z0-9+/]+=*$/).max(MAX_READ_SNAPSHOT_BYTES),
    recipients: z
      .array(
        z
          .object({
            keyId: z.string().regex(KEY_ID),
            ephemeralPublicKeyB64: B64_32,
            nonceB64: B64_NONCE,
            wrappedKeyB64: z.string().regex(/^[A-Za-z0-9+/]{64}$/)
          })
          .strict()
      )
      .max(MAX_READ_RECIPIENTS),
    // The VM's own signature over the body; relayed untouched (devices verify and pin the signer).
    signature: z.object({ publicKeyB64: B64_32, signatureB64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict().optional(),
    // Timing only: nothing about the plaintext's shape is logged here.
    stats: z.object({ collectMs: z.number().int().min(0).max(600_000) }).strict().optional()
  })
  .strict()

type CaptureOutcome =
  | { captured: true; snapshotId: string; recipients: number; bytes: number; stats?: { collectMs: number } }
  | { captured: false; reason: string }
export type CaptureResult = CaptureOutcome & { ms: number }

/**
 * Best effort, before orcad drains: the VM gathers and seals the snapshot (it never leaves the VM
 * in plaintext); this stores the ciphertext and replaces the previous one. A failure keeps the old
 * snapshot and never blocks the sleep.
 */
export async function captureReadSnapshot(deps: LifecycleDeps, row: SandboxRow, reason: string): Promise<CaptureResult> {
  const started = deps.now()
  const done = (r: CaptureOutcome): CaptureResult => {
    const result: CaptureResult = { ...r, ms: deps.now() - started }
    console.log(JSON.stringify({ event: 'read_snapshot', sandboxId: row.id, reason, ...result }))
    return result
  }
  if (!row.session_id) {
    return done({ captured: false, reason: 'no_session' })
  }
  const keys = await readerKeysFor(deps.db, row, deps.now())
  if (keys.length === 0) {
    return done({ captured: false, reason: 'no_reader_keys' })
  }
  const snapshotId = randomHexId('rsn')
  const sessionId = row.session_id
  let stdout: string
  try {
    // VMs booted from an older image get the current entry points (this script) first.
    await ensureEntryPoints(deps, sessionId).catch(() => undefined)
    const result = await deps.provider.runCommand(sessionId, {
        command: READ_SNAPSHOT_COMMAND,
        env: {
          ORCA_READ_SNAPSHOT_ID: snapshotId,
          ORCA_READ_WORKSPACE_ID: row.id,
          ORCA_READ_REASON: reason,
          ORCA_READ_RECIPIENTS: JSON.stringify(keys.map((k) => ({ keyId: k.id, publicKeyB64: k.public_key })))
        },
        timeoutMs: READ_SNAPSHOT_TIMEOUT_MS
      })
    if (result.exitCode !== 0) {
      return done({ captured: false, reason: `exit_${result.exitCode}:${result.stderr.trim().slice(0, 120)}` })
    }
    stdout = result.stdout
  } catch (error) {
    return done({ captured: false, reason: `run_failed:${String(error).slice(0, 120)}` })
  }
  let parsed: z.infer<typeof VmOutputSchema>
  try {
    const line = stdout.trim().split('\n').pop() ?? ''
    const out = VmOutputSchema.safeParse(JSON.parse(line))
    if (!out.success) {
      return done({ captured: false, reason: 'bad_output' })
    }
    parsed = out.data
  } catch {
    return done({ captured: false, reason: 'bad_output' })
  }
  const asked = new Set(keys.map((k) => k.id))
  if (parsed.snapshotId !== snapshotId || parsed.workspaceId !== row.id || parsed.recipients.some((r) => !asked.has(r.keyId))) {
    return done({ captured: false, reason: 'mismatched_output' })
  }
  const now = deps.now()
  const statements = [
    deps.db.prepare('DELETE FROM read_snapshot_keys WHERE sandbox_id = ?').bind(row.id),
    deps.db
      .prepare(
        `INSERT INTO read_snapshots (sandbox_id, snapshot_id, stored_at, bytes, nonce, ciphertext, signature) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sandbox_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, stored_at = excluded.stored_at,
           bytes = excluded.bytes, nonce = excluded.nonce, ciphertext = excluded.ciphertext, signature = excluded.signature`
      )
      .bind(
        row.id,
        snapshotId,
        now,
        parsed.ciphertextB64.length,
        parsed.nonceB64,
        parsed.ciphertextB64,
        parsed.signature ? JSON.stringify(parsed.signature) : null
      ),
    ...parsed.recipients.map((r) =>
      deps.db
        .prepare(
          'INSERT INTO read_snapshot_keys (sandbox_id, key_id, snapshot_id, ephemeral_public_key, nonce, wrapped_key) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(row.id, r.keyId, snapshotId, r.ephemeralPublicKeyB64, r.nonceB64, r.wrappedKeyB64)
    ),
    // A key revoked (or a member removed) while the VM was sealing must not slip back in.
    deps.db
      .prepare(
        `DELETE FROM read_snapshot_keys WHERE sandbox_id = ? AND key_id IN (SELECT id FROM reader_keys WHERE revoked_at IS NOT NULL)`
      )
      .bind(row.id)
  ]
  await deps.db.batch(statements)
  // The workspace may have been made private while sealing: re-apply the current rule.
  const current = await deps.db.prepare('SELECT * FROM sandboxes WHERE id = ?').bind(row.id).first<SandboxRow>()
  if (current && current.visibility !== 'team') {
    await pruneReadSnapshotToOwner(deps.db, current)
  }
  return done({
    captured: true,
    snapshotId,
    recipients: parsed.recipients.length,
    bytes: parsed.ciphertextB64.length,
    ...(parsed.stats ? { stats: parsed.stats } : {})
  })
}

const StoredSignatureSchema = z.object({ publicKeyB64: z.string(), signatureB64: z.string() }).strict()

function signatureOf(stored: string | null): { signature?: z.infer<typeof StoredSignatureSchema> } {
  if (!stored) {
    return {}
  }
  try {
    const parsed = StoredSignatureSchema.safeParse(JSON.parse(stored))
    return parsed.success ? { signature: parsed.data } : {}
  } catch {
    return {}
  }
}

/** For workspace views: when each workspace's snapshot was stored (only rows the caller can open). */
export async function readSnapshotTimes(db: D1Database, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    if (chunk.length === 0) {
      continue
    }
    const { results } = await db
      .prepare(`SELECT sandbox_id, stored_at FROM read_snapshots WHERE sandbox_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ sandbox_id: string; stored_at: number }>()
    for (const r of results) {
      out.set(r.sandbox_id, r.stored_at)
    }
  }
  return out
}

export async function getReadSnapshot(db: D1Database, caller: SandboxCaller, row: SandboxRow, keyId: string | null, now: number) {
  // Belt and braces over canOpen: a private workspace's snapshot opens only for its owner.
  if (!canOpen(caller, row) || (row.visibility !== 'team' && !isOwner(caller, row))) {
    throw new WorkspaceError('not_found')
  }
  if (!keyId || !KEY_ID.test(keyId)) {
    throw new ReadSnapshotRouteError('invalid_request', 400)
  }
  // The key must be the caller's own, live one: nobody fetches another member's wrapped key.
  const key = await db
    .prepare('SELECT * FROM reader_keys WHERE id = ? AND account_id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(keyId, caller.accountId, caller.userId)
    .first<ReaderKeyRow>()
  // A phone reads only with its own key (least privilege; desktop tokens have no device session).
  if (!key || (caller.deviceSessionId && key.device_session_id !== caller.deviceSessionId)) {
    throw new ReadSnapshotRouteError('invalid_request', 400)
  }
  const snapshot = await db
    .prepare('SELECT * FROM read_snapshots WHERE sandbox_id = ?')
    .bind(row.id)
    .first<{ snapshot_id: string; stored_at: number; nonce: string; ciphertext: string; signature: string | null }>()
  if (!snapshot) {
    throw new ReadSnapshotRouteError('no_snapshot', 404)
  }
  const wrapped = await db
    .prepare('SELECT * FROM read_snapshot_keys WHERE sandbox_id = ? AND key_id = ? AND snapshot_id = ?')
    .bind(row.id, keyId, snapshot.snapshot_id)
    .first<{ ephemeral_public_key: string; nonce: string; wrapped_key: string }>()
  if (!wrapped) {
    throw new ReadSnapshotRouteError('not_sealed_for_key', 404)
  }
  if (now - key.last_seen_at > 60 * 60_000) {
    await db.prepare('UPDATE reader_keys SET last_seen_at = ? WHERE id = ?').bind(now, key.id).run()
  }
  return {
    snapshot: {
      v: 1 as const,
      snapshotId: snapshot.snapshot_id,
      workspaceId: row.id,
      storedAt: snapshot.stored_at,
      nonceB64: snapshot.nonce,
      ciphertextB64: snapshot.ciphertext,
      recipient: {
        keyId,
        ephemeralPublicKeyB64: wrapped.ephemeral_public_key,
        nonceB64: wrapped.nonce,
        wrappedKeyB64: wrapped.wrapped_key
      },
      ...signatureOf(snapshot.signature)
    }
  }
}


export type ReaderKeysRouteDeps = { db: D1Database; caller: SandboxCaller; now: number; readJson: () => Promise<unknown> }

export async function handleReaderKeysRoute(request: Request, url: URL, deps: ReaderKeysRouteDeps): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const match = /^\/v1\/reader-keys(?:\/(rk_[0-9a-f]{24}))?$/.exec(url.pathname)
  if (!match) {
    return json({ error: 'not_found' }, 404)
  }
  const [, id] = match
  try {
    if (!id && request.method === 'PUT') {
      const body = ReaderKeyRequestSchema.safeParse(await deps.readJson())
      if (!body.success) {
        return json({ error: 'invalid_request' }, 400)
      }
      return json({ readerKey: readerKeyView(await registerReaderKey(deps.db, deps.caller, body.data, deps.now)) })
    }
    if (!id && request.method === 'GET') {
      const { results } = await deps.db
        .prepare('SELECT * FROM reader_keys WHERE account_id = ? AND user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC')
        .bind(deps.caller.accountId, deps.caller.userId)
        .all<ReaderKeyRow>()
      return json({ readerKeys: results.map(readerKeyView) })
    }
    if (id && request.method === 'DELETE') {
      const owned = await deps.db
        .prepare('SELECT id FROM reader_keys WHERE id = ? AND account_id = ? AND user_id = ? AND revoked_at IS NULL')
        .bind(id, deps.caller.accountId, deps.caller.userId)
        .first<{ id: string }>()
      if (!owned) {
        return json({ error: 'not_found' }, 404)
      }
      await revokeReaderKeys(deps.db, [id], deps.caller.userId, deps.now)
      return json({ ok: true })
    }
    return json({ error: 'not_found' }, 404)
  } catch (error) {
    if (error instanceof ReadSnapshotRouteError) {
      return json({ error: error.code }, error.status)
    }
    throw error
  }
}
