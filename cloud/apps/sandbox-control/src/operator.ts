// Operator-only routes (Bearer OPERATOR_TOKEN, a Worker secret; absent = routes do not exist):
//   GET    /v1/internal/status
//   POST   /v1/internal/kill-switch {enabled, drain?}   refuse creates/resumes; drain suspends (snapshot kept)
//   POST   /v1/internal/drain-all
//   POST   /v1/internal/housekeeping                    orphan sweep + retention now
//   POST   /v1/internal/github/bindings {installationId, accountId}   support binding (audited as `operator`)
//   DELETE /v1/internal/github/bindings {installationId, accountId?}
//   POST   /v1/internal/members/role-changed {accountId, userId, role}   re-cap their keys and MCP grants (auth calls this)
//   POST   /v1/internal/members/removed {accountId, userId}   revoke a departed member's API keys, disable their routines (auth calls this)
import { z } from 'zod'
import { audit } from './api/audit'
import { syncMemberRole } from './api/member-role-sync'
import { readBearer } from './auth'
import type { GitHubAppMinter } from './github-app'
import { bindInstallation, revokeInstallation, timingSafeEqual } from './github-connect'
import { countAllActive, getControlState, killSwitchOn, setKillSwitch } from './guardrails'
import { guardrails, type LifecycleDeps } from './lifecycle'
import { drainAll, housekeeping } from './retention'
import { disableMemberRoutines } from './routines/runs'
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
const MemberRemovedBody = z.object({ accountId: AccountId, userId: z.string().min(1).max(128) }).strict()
const RoleChangedBody = z.object({ accountId: AccountId, userId: z.string().min(1).max(128), role: z.enum(['owner', 'admin', 'member']) }).strict()
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
  deps: { life: LifecycleDeps; github?: GitHubAppMinter; readJson: () => Promise<unknown> }
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
      const updated = await syncMemberRole(life.db, body.data.accountId, body.data.userId, body.data.role)
      await audit(life.db, { accountId: body.data.accountId, type: 'system', id: 'auth', userId: body.data.userId }, { action: 'member.role_changed', detail: { role: body.data.role, keysUpdated: updated } }, now)
      return Response.json({ updated })
    }
    case 'POST /v1/internal/members/removed': {
      const body = MemberRemovedBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      // A key acts as the person who made it: once they leave the org, none of theirs may work.
      const result = await life.db
        .prepare(`UPDATE api_keys SET revoked_at = ?, revoked_by = 'system:member_removed' WHERE account_id = ? AND created_by = ? AND revoked_at IS NULL`)
        .bind(now, body.data.accountId, body.data.userId)
        .run()
      // MCP OAuth tokens are api_keys rows (revoked above); pending codes and approvals die too.
      await life.db.batch([
        life.db.prepare('UPDATE oauth_codes SET consumed_at = ? WHERE account_id = ? AND user_id = ? AND consumed_at IS NULL').bind(now, body.data.accountId, body.data.userId),
        life.db.prepare('UPDATE oauth_approvals SET consumed_at = ? WHERE account_id = ? AND user_id = ? AND consumed_at IS NULL').bind(now, body.data.accountId, body.data.userId)
      ])
      // Routines run with their creator's secrets: a departed member's stop, and nothing of theirs keeps running.
      const routines = await disableMemberRoutines({ life }, body.data.accountId, body.data.userId)
      await audit(life.db, { accountId: body.data.accountId, type: 'system', id: 'auth', userId: body.data.userId }, { action: 'member.removed', detail: { keysRevoked: result.meta.changes, routinesDisabled: routines.disabled, runsCancelled: routines.cancelled } }, now)
      return Response.json({ revoked: result.meta.changes, routinesDisabled: routines.disabled })
    }
    default:
      return null
  }
}
