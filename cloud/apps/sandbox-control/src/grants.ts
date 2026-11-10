// Per-member, per-device access to a workspace's orcad, issued through the control plane without
// the control plane ever holding a usable credential:
//   POST   /v1/team/workspaces/:id/grants {recipientPublicKeyB64, deviceLabel, deviceKind}
//          -> {grant, sealed}  (the VM mints a fresh single-device orcad offer and seals it to the
//             device's X25519 key; see image/vm/orca-sandbox-grant and src/shared/cloud-workspaces)
//   GET    /v1/team/workspaces/:id/grants            owner/admin: every grant; member: their own
//   DELETE /v1/team/workspaces/:id/grants/:grantId   grantee, workspace owner or org admin
// Revocation removes the device from orcad's registry (orca-sandbox-revoke); while the sandbox is
// not running it is queued and applied at the next boot before orcad starts.
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import { isDeviceSessionLive } from './device-sessions'
import { markRevoked, runVmRevoke, type GrantRow } from './grant-revokes'
import { LifecycleError, resumeSandbox, syncMemberGit, type LifecycleDeps } from './lifecycle'
import { ensureEntryPoints } from './golden-images'
import type { CommandResult } from './sandbox-provider'
import { ORCAD_PORT } from './sandbox-vm-commands'
import { getSandbox, touchActivity, type SandboxRow } from './store'
import { WorkspaceError, canOpen, isOrgAdmin, isOwner } from './workspaces'

export const GRANT_COMMAND = '/opt/orca/bin/orca-sandbox-grant'
const GRANT_TIMEOUT_MS = 45_000
const MAX_ACTIVE_GRANTS_PER_USER = 8

const B64_32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine((value) => atob(value).length === 32, 'expected 32 bytes')

export const GrantRequestSchema = z
  .object({
    recipientPublicKeyB64: B64_32,
    deviceLabel: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f]+$/),
    deviceKind: z.enum(['desktop', 'mobile'])
  })
  .strict()

const SealedSchema = z
  .object({
    v: z.literal(1),
    ephemeralPublicKeyB64: B64_32,
    nonceB64: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    ciphertextB64: z.string().regex(/^[A-Za-z0-9+/=]{24,16384}$/)
  })
  .strict()

const GrantOutputSchema = z.object({ deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sealed: SealedSchema }).strict()

/**
 * VMs booted from an image older than these entry points (grant/revoke/members) get the control
 * plane's current scripts installed once, then the command is retried.
 */
export async function withEntryPoints(
  deps: Pick<LifecycleDeps, 'provider'>,
  sessionId: string,
  command: string,
  run: () => Promise<CommandResult>
): Promise<CommandResult> {
  // Stale or missing scripts from an older image are replaced first (one marker check when current).
  await ensureEntryPoints(deps, sessionId).catch(() => undefined)
  void command
  return run()
}

function randomGrantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `grt_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function grantView(row: GrantRow) {
  return {
    id: row.id,
    workspaceId: row.sandbox_id,
    userId: row.user_id,
    deviceKind: row.device_kind,
    deviceLabel: row.device_label,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  }
}

async function liveSession(deps: LifecycleDeps, row: SandboxRow): Promise<{ row: SandboxRow; sessionId: string; wss: string }> {
  let current = row
  if (current.status !== 'running') {
    // Opening a teammate's sleeping workspace wakes it (billed to the org, like any resume). The
    // resume's pairing offer is the owner's and is dropped here.
    current = (await resumeSandbox(deps, current)).row
  }
  const state = await deps.provider.getSandbox(current.provider_name, { resume: false })
  const route = state?.routes.find((r) => r.port === ORCAD_PORT)
  if (!state || state.session.status !== 'running' || !route) {
    throw new LifecycleError('conflict', 'sandbox_not_running')
  }
  return { row: current, sessionId: state.session.id, wss: route.url.replace(/^https:/, 'wss:') }
}

export async function issueGrant(
  deps: LifecycleDeps,
  caller: SandboxCaller,
  row: SandboxRow,
  body: z.infer<typeof GrantRequestSchema>
) {
  if (!canOpen(caller, row)) {
    throw new WorkspaceError('not_found')
  }
  const { n } = (await deps.db
    .prepare(`SELECT COUNT(*) AS n FROM workspace_grants WHERE sandbox_id = ? AND user_id = ? AND status IN ('issuing', 'active')`)
    .bind(row.id, caller.userId)
    .first<{ n: number }>()) ?? { n: 0 }
  if (n >= MAX_ACTIVE_GRANTS_PER_USER) {
    throw new WorkspaceError('conflict', 'too_many_devices')
  }
  const live = await liveSession(deps, row)
  const id = randomGrantId()
  const now = deps.now()
  await deps.db
    .prepare(
      `INSERT INTO workspace_grants (id, sandbox_id, account_id, user_id, device_kind, device_label, status, created_at, device_session_id)
       VALUES (?, ?, ?, ?, ?, ?, 'issuing', ?, ?)`
    )
    .bind(id, row.id, row.account_id, caller.userId, body.deviceKind, body.deviceLabel, now, caller.deviceSessionId ?? null)
    .run()
  let output: z.infer<typeof GrantOutputSchema>
  try {
    const result = await withEntryPoints(deps, live.sessionId, GRANT_COMMAND, () =>
      deps.provider.runCommand(live.sessionId, {
        command: GRANT_COMMAND,
        env: {
          ORCA_GRANT_ID: id,
          ORCA_GRANT_RECIPIENT_KEY: body.recipientPublicKeyB64,
          ORCA_GRANT_KIND: body.deviceKind,
          ORCA_PUBLIC_WSS: live.wss
        },
        timeoutMs: GRANT_TIMEOUT_MS
      })
    )
    if (result.exitCode !== 0) {
      throw new Error(`grant_exit_${result.exitCode}`)
    }
    output = GrantOutputSchema.parse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''))
  } catch {
    await deps.db.prepare(`UPDATE workspace_grants SET status = 'failed' WHERE id = ?`).bind(id).run()
    throw new LifecycleError('provider_unavailable', 'grant_failed')
  }
  // Re-check after the slow VM call: if the workspace went private or changed hands, or the phone
  // that asked was revoked meanwhile, the device is revoked at once instead of slipping through.
  const after = await getSandbox(deps.db, row.id)
  const sessionLive = !caller.deviceSessionId || (await isDeviceSessionLive(deps.db, caller.deviceSessionId, deps.now()))
  const stillAllowed = after !== null && canOpen(caller, after) && sessionLive
  // Only an `issuing` row may become active: a revoke that ran during the VM call (member removed,
  // phone revoked) already moved it on, and saw no device id to kill, so it must not be undone.
  const activated = await deps.db
    .prepare(`UPDATE workspace_grants SET status = ?, orcad_device_id = ? WHERE id = ? AND status = 'issuing'`)
    .bind(stillAllowed ? 'active' : 'revoking', output.deviceId, id)
    .run()
  if (activated.meta.changes === 0) {
    await deps.db
      .prepare(`UPDATE workspace_grants SET status = 'revoking', orcad_device_id = ? WHERE id = ?`)
      .bind(output.deviceId, id)
      .run()
  }
  const grant = (await getGrant(deps.db, id))!
  if (!stillAllowed || activated.meta.changes === 0) {
    const audit = activated.meta.changes === 0
      ? { by: grant.revoked_by ?? 'system', reason: grant.revoke_reason ?? 'access_changed' }
      : { by: 'system', reason: 'access_changed' }
    await revokeGrants(deps, after ?? live.row, [grant], audit)
    throw new WorkspaceError('not_found')
  }
  await touchActivity(deps.db, row.id, caller.userId, deps.now())
  // The new member's own GitHub identity becomes usable for pushes from this workspace.
  await syncMemberGit(deps, after, live.sessionId)
  // Counts only; never the sealed box or the device id.
  console.log(JSON.stringify({ event: 'grant_issued', sandboxId: row.id, kind: body.deviceKind }))
  return { grant: grantView(grant), sealed: output.sealed }
}

export function getGrant(db: D1Database, id: string): Promise<GrantRow | null> {
  return db.prepare('SELECT * FROM workspace_grants WHERE id = ?').bind(id).first<GrantRow>()
}

export async function listGrants(db: D1Database, caller: SandboxCaller, row: SandboxRow) {
  const everyone = isOwner(caller, row) || (isOrgAdmin(caller) && row.account_id === caller.accountId)
  const { results } = await db
    .prepare(
      `SELECT * FROM workspace_grants WHERE sandbox_id = ? AND status IN ('issuing', 'active', 'revoking')
       ${everyone ? '' : 'AND user_id = ?'} ORDER BY created_at`
    )
    .bind(...(everyone ? [row.id] : [row.id, caller.userId]))
    .all<GrantRow>()
  return { grants: results.map(grantView) }
}

/** Revokes now when the VM is up; otherwise queues (`revoking`) for the next boot. */
export async function revokeGrants(
  deps: LifecycleDeps,
  row: SandboxRow,
  grants: readonly GrantRow[],
  audit: { by: string; reason: string }
): Promise<{ revoked: number; queued: number }> {
  const open = grants.filter((g) => g.status !== 'revoked' && g.status !== 'failed')
  if (open.length === 0) {
    return { revoked: 0, queued: 0 }
  }
  const now = deps.now()
  await deps.db.batch(
    open.map((g) =>
      deps.db
        .prepare(`UPDATE workspace_grants SET status = 'revoking', revoked_by = ?, revoke_reason = ?, revoked_at = ? WHERE id = ? AND status <> 'revoked'`)
        .bind(audit.by, audit.reason, now, g.id)
    )
  )
  if (row.status === 'running' && row.session_id && (await runVmRevoke(deps.provider, row.session_id, open))) {
    await markRevoked(deps.db, open, now)
    await syncMemberGit(deps, row, row.session_id)
    return { revoked: open.length, queued: 0 }
  }
  return { revoked: 0, queued: open.length }
}

export async function revokeOne(deps: LifecycleDeps, caller: SandboxCaller, row: SandboxRow, grantId: string) {
  const grant = await getGrant(deps.db, grantId)
  if (!grant || grant.sandbox_id !== row.id) {
    throw new WorkspaceError('not_found')
  }
  const allowed = grant.user_id === caller.userId || isOwner(caller, row) || (isOrgAdmin(caller) && row.account_id === caller.accountId)
  if (!allowed) {
    throw new WorkspaceError('not_found')
  }
  const result = await revokeGrants(deps, row, [grant], { by: caller.userId, reason: 'revoked' })
  return { grant: grantView((await getGrant(deps.db, grantId))!), ...result }
}

/** Access rules changed (private, archived, new owner): drop every device the new rules exclude. */
export async function revokeForAccessChange(
  deps: LifecycleDeps,
  row: SandboxRow,
  mode: 'non_owner' | 'all_but_new_owner',
  by: string
) {
  const { results } = await deps.db
    .prepare(`SELECT * FROM workspace_grants WHERE sandbox_id = ? AND user_id <> ? AND status IN ('issuing', 'active')`)
    .bind(row.id, row.user_id)
    .all<GrantRow>()
  return revokeGrants(deps, row, results, { by, reason: mode === 'non_owner' ? 'workspace_private' : 'owner_changed' })
}

/** A member left the org (auth push) or a phone session ended (W8): revoke everywhere. */
async function revokeWhere(deps: LifecycleDeps, where: string, binds: (string | number)[], audit: { by: string; reason: string }) {
  const { results } = await deps.db
    .prepare(`SELECT * FROM workspace_grants WHERE ${where} AND status IN ('issuing', 'active')`)
    .bind(...binds)
    .all<GrantRow>()
  const bySandbox = new Map<string, GrantRow[]>()
  for (const g of results) {
    bySandbox.set(g.sandbox_id, [...(bySandbox.get(g.sandbox_id) ?? []), g])
  }
  let revoked = 0
  let queued = 0
  for (const [sandboxId, grants] of bySandbox) {
    const row = await getSandbox(deps.db, sandboxId)
    if (!row) {
      continue
    }
    const r = await revokeGrants(deps, row, grants, audit)
    revoked += r.revoked
    queued += r.queued
  }
  return { revoked, queued }
}

export function revokeGrantsForMember(deps: LifecycleDeps, accountId: string, userId: string) {
  return revokeWhere(deps, 'account_id = ? AND user_id = ?', [accountId, userId], { by: 'system', reason: 'member_removed' })
}

export function revokeGrantsForDeviceSession(deps: LifecycleDeps, deviceSessionId: string) {
  return revokeWhere(deps, 'device_session_id = ?', [deviceSessionId], { by: 'system', reason: 'device_session_revoked' })
}

/**
 * The creator's desktop pairs with the create's own offer; record that device (its id is in the
 * offer, not secret) so reassigning the workspace or removing the member revokes it like any grant.
 */
export async function recordOwnerDevice(db: D1Database, row: SandboxRow, pairingCode: string, now: number): Promise<boolean> {
  const deviceId = pairedDeviceIdOf(pairingCode)
  if (!deviceId) {
    return false
  }
  const existing = await db
    .prepare('SELECT id FROM workspace_grants WHERE sandbox_id = ? AND orcad_device_id = ?')
    .bind(row.id, deviceId)
    .first<{ id: string }>()
  if (existing) {
    return false
  }
  await db
    .prepare(
      `INSERT INTO workspace_grants (id, sandbox_id, account_id, user_id, device_kind, device_label, orcad_device_id, status, created_at)
       VALUES (?, ?, ?, ?, 'desktop', 'Owner desktop', ?, 'active', ?)`
    )
    .bind(randomGrantId(), row.id, row.account_id, row.user_id, deviceId, now)
    .run()
  return true
}

/** Records the owner's device and, when it is new, lets the VM map it to the owner (git as the sender). */
export async function recordOwnerDeviceAndSync(deps: LifecycleDeps, row: SandboxRow, pairingCode: string): Promise<void> {
  if ((await recordOwnerDevice(deps.db, row, pairingCode, deps.now())) && row.status === 'running' && row.session_id) {
    await syncMemberGit(deps, row, row.session_id)
  }
}

export function pairedDeviceIdOf(pairingCode: string): string | null {
  try {
    const code = new URL(pairingCode).searchParams.get('code')
    if (!code) {
      return null
    }
    const json = JSON.parse(atob(code.replace(/-/g, '+').replace(/_/g, '/'))) as { pairedDeviceId?: unknown }
    return typeof json.pairedDeviceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(json.pairedDeviceId) ? json.pairedDeviceId : null
  } catch {
    return null
  }
}
