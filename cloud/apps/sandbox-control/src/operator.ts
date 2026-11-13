// Operator-only routes (Bearer OPERATOR_TOKEN, a Worker secret; absent = routes do not exist):
//   GET    /v1/internal/status
//   POST   /v1/internal/kill-switch {enabled, drain?}   refuse creates/resumes; drain suspends (snapshot kept)
//   POST   /v1/internal/drain-all
//   POST   /v1/internal/housekeeping                    orphan sweep + retention now
//   POST   /v1/internal/github/bindings {installationId, accountId}   support binding (audited as `operator`)
//   DELETE /v1/internal/github/bindings {installationId, accountId?}
//   POST   /v1/internal/members/role-changed {accountId, userId, role}   re-cap their keys and MCP grants (auth calls this)
//   POST   /v1/internal/members/removed {accountId, userId}   revoke a departed member's keys, phones and workspace grants, disable their routines (auth calls this)
//   GET    /v1/internal/fair-use?days=30                 per-account CPU utilisation + fair-use flag (U22; internal only, never billed)
//   POST   /v1/internal/session-cpu/sweep               fetch CPU for recently stopped sessions now (the cron does this every 5 min)
//   GET    /v1/internal/secrets/kek                     which KEK ids stored secrets reference; which retired ids can be dropped
//   POST   /v1/internal/secrets/rewrap {limit?, cursor?, dryRun?}   move one batch of rows to the active KEK (secrets-rewrap.ts)
import { z } from 'zod'
import { audit } from './api/audit'
import { syncMemberRole } from './api/member-role-sync'
import { readBearer } from './auth'
import type { GitHubAppMinter } from './github-app'
import { bindInstallation, revokeInstallation, timingSafeEqual } from './github-connect'
import { countAllActive, getControlState, killSwitchOn, setKillSwitch } from './guardrails'
import { guardrails, type LifecycleDeps } from './lifecycle'
import { drainAll, housekeeping } from './retention'
import { memberChangeTime, recordMemberChange } from './member-changes'
import { removeMember } from './member-removal'
import type { Keyring } from './secrets-crypto'
import { kekStatus, rewrapBatch, RewrapError, REWRAP_MAX_LIMIT } from './secrets-rewrap'
import { fairUseReport, FAIR_USE_WINDOW_DAYS, sweepSessionCpu } from './session-cpu'
import { listByStatus } from './store'

const KillSwitchBody = z.object({ enabled: z.boolean(), drain: z.boolean().optional() }).strict()
const AccountId = z.string().min(1).max(160).regex(/^(user|org|dev):[A-Za-z0-9_.:-]+$/)
const BindingBody = z
  .object({
    installationId: z.number().int().positive().optional(),
    /** Alternative to installationId: the installation covering this github.com repo. */
    repoUrl: z.url({ protocol: /^https$/ }).max(2048).optional(),
    accountId: AccountId
  })
  .strict()
  .refine((body) => (body.installationId === undefined) !== (body.repoUrl === undefined))
// `changedAt`: auth's time of the change (ms), so tokens auth issued up to then count as stale.
const ChangedAt = z.number().int().positive().optional()
const MemberRemovedBody = z.object({ accountId: AccountId, userId: z.string().min(1).max(128), changedAt: ChangedAt }).strict()
const RoleChangedBody = z.object({ accountId: AccountId, userId: z.string().min(1).max(128), role: z.enum(['owner', 'admin', 'member']), changedAt: ChangedAt }).strict()
const RewrapBody = z
  .object({ limit: z.number().int().min(1).max(REWRAP_MAX_LIMIT).optional(), cursor: z.string().max(2048).nullable().optional(), dryRun: z.boolean().optional() })
  .strict()
const UnbindBody = z.object({ installationId: z.number().int().positive(), accountId: AccountId.optional() }).strict()

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

export async function isOperator(request: Request, operatorToken: string | undefined): Promise<boolean> {
  const presented = readBearer(request.headers.get('authorization'))
  if (!operatorToken || operatorToken.length < 32 || !presented) {
    return false
  }
  return timingSafeEqual(await digest(presented), await digest(operatorToken))
}

export async function handleOperator(
  request: Request,
  path: string,
  deps: {
    life: LifecycleDeps
    github?: GitHubAppMinter
    readJson: () => Promise<unknown>
    /** The Worker's keyring; null when SECRETS_KEK is not configured. Throws on a malformed key config. */
    keyring?: () => Promise<Keyring> | null
  }
): Promise<Response | null> {
  const { life } = deps
  const now = life.now()
  const route = `${request.method} ${path}`
  switch (route) {
    case 'GET /v1/internal/status':
      return Response.json({
        killSwitch: await killSwitchOn(life.db, guardrails(life)),
        staticDisabled: guardrails(life).startsDisabled,
        active: await countAllActive(life.db),
        running: (await listByStatus(life.db, ['running'])).length,
        guardrails: guardrails(life),
        lastHousekeepingAt: Number((await getControlState(life.db, 'housekeeping_at')) ?? 0) || null
      })
    case 'POST /v1/internal/kill-switch': {
      const body = KillSwitchBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      await setKillSwitch(life.db, body.data.enabled, now)
      console.log(JSON.stringify({ event: 'kill_switch', enabled: body.data.enabled }))
      const drained = body.data.enabled && body.data.drain !== false ? await drainAll(life) : null
      return Response.json({ killSwitch: body.data.enabled, drained })
    }
    case 'POST /v1/internal/drain-all':
      return Response.json({ drained: await drainAll(life) })
    case 'POST /v1/internal/housekeeping':
      return Response.json({ housekeeping: await housekeeping(life, { force: true }) })
    case 'POST /v1/internal/github/bindings': {
      const body = BindingBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      if (!deps.github) {
        return Response.json({ error: 'not_configured' }, { status: 503 })
      }
      const installation = body.data.installationId
        ? await deps.github.getInstallation(body.data.installationId)
        : await deps.github.getRepoInstallation(body.data.repoUrl!)
      if (!installation) {
        return Response.json({ error: 'not_found' }, { status: 404 })
      }
      await bindInstallation(
        life.db,
        {
          installation_id: installation.id,
          account_id: body.data.accountId,
          github_account_id: installation.account.id,
          github_account_login: installation.account.login,
          github_account_type: installation.account.type,
          bound_by_user_id: 'operator',
          bound_by_github_user_id: null,
          method: 'operator'
        },
        now
      )
      console.log(JSON.stringify({ event: 'github_bind_operator', installationId: installation.id, accountId: body.data.accountId }))
      return Response.json({ bound: { installationId: installation.id, accountId: body.data.accountId, githubAccount: installation.account.login } })
    }
    case 'DELETE /v1/internal/github/bindings': {
      const body = UnbindBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      const revoked = await revokeInstallation(life.db, body.data.installationId, body.data.accountId ?? null, now)
      console.log(JSON.stringify({ event: 'github_unbind_operator', installationId: body.data.installationId, revoked }))
      return Response.json({ revoked })
    }
    case 'POST /v1/internal/members/role-changed': {
      const body = RoleChangedBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      // First, so a desktop token minted before the change can't sync the old role back.
      await recordMemberChange(life.db, body.data.accountId, body.data.userId, 'role', memberChangeTime(now, body.data.changedAt))
      const updated = await syncMemberRole(life.db, body.data.accountId, body.data.userId, body.data.role)
      await audit(life.db, { accountId: body.data.accountId, type: 'system', id: 'auth', userId: body.data.userId }, { action: 'member.role_changed', detail: { role: body.data.role, keysUpdated: updated } }, now)
      return Response.json({ updated })
    }
    case 'POST /v1/internal/members/removed': {
      const body = MemberRemovedBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      // Same cleanup as /v1/internal/org-members/removed: whichever auth calls, nothing of theirs survives.
      const removal = await removeMember(life, body.data.accountId, body.data.userId, now, body.data.changedAt)
      return Response.json({ revoked: removal.keysRevoked, ...removal })
    }
    case 'GET /v1/internal/fair-use': {
      const days = Number(new URL(request.url).searchParams.get('days') ?? FAIR_USE_WINDOW_DAYS)
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      return Response.json(await fairUseReport(life.db, now, days), { headers: { 'cache-control': 'no-store' } })
    }
    case 'POST /v1/internal/session-cpu/sweep':
      return Response.json({ sweep: await sweepSessionCpu(life.db, life.provider, now) })
    case 'GET /v1/internal/secrets/kek':
    case 'POST /v1/internal/secrets/rewrap': {
      const noStore = { 'cache-control': 'no-store' }
      let keyring: Keyring | null
      try {
        keyring = (await deps.keyring?.()) ?? null
      } catch {
        // A malformed SECRETS_KEK* value. The cause is not echoed: it could quote key material.
        return Response.json({ error: 'secrets_misconfigured' }, { status: 503, headers: noStore })
      }
      if (!keyring) {
        return Response.json({ error: 'secrets_unconfigured' }, { status: 503, headers: noStore })
      }
      if (request.method === 'GET') {
        return Response.json(await kekStatus(life.db, keyring), { headers: noStore })
      }
      const body = RewrapBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400, headers: noStore })
      }
      try {
        return Response.json(await rewrapBatch(life.db, keyring, body.data), { headers: noStore })
      } catch (error) {
        if (error instanceof RewrapError) {
          return Response.json({ error: 'invalid_request', reason: error.reason }, { status: 400, headers: noStore })
        }
        throw error
      }
    }
    default:
      return null
  }
}
