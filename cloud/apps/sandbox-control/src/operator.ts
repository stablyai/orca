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
import { applySandboxPolicy, egressSwapModeFor, guardrails, scrubRecordPolicy, type LifecycleDeps } from './lifecycle'
import { drainAll, housekeeping } from './retention'
import { memberChangeTime, recordMemberChange } from './member-changes'
import { memberEventActor, memberEventTarget, removeMember } from './member-removal'
import type { Keyring } from './secrets-crypto'
import { SecretsKmsError } from './secrets-kms'
import { kekStatus, rewrapBatch, RewrapError, REWRAP_MAX_LIMIT } from './secrets-rewrap'
import { fairUseReport, FAIR_USE_WINDOW_DAYS, sweepSessionCpu } from './session-cpu'
import { getSandbox, listByStatus } from './store'

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
// `actorUserId`: who made the change in auth (absent for a directory sync or an older auth), for the audit log.
const ActorUserId = z.string().min(1).max(128).optional()
const MemberRemovedBody = z.object({ accountId: AccountId, userId: z.string().min(1).max(128), changedAt: ChangedAt, actorUserId: ActorUserId }).strict()
const RoleChangedBody = z.object({ accountId: AccountId, userId: z.string().min(1).max(128), role: z.enum(['owner', 'admin', 'member']), changedAt: ChangedAt, actorUserId: ActorUserId }).strict()
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
  // Design §3: one sandbox's swap mode (canary or rollback), applied at once. `null` returns it to the default.
  const egressMode = /^\/v1\/internal\/sandboxes\/([A-Za-z0-9_]+)\/egress-mode$/.exec(path)
  if (egressMode && request.method === 'POST') {
    const body = EgressModeBody.safeParse(await deps.readJson())
    const row = body.success ? await getSandbox(life.db, egressMode[1]!) : null
    if (!body.success || !row) {
      return Response.json({ error: body.success ? 'not_found' : 'invalid_request' }, { status: body.success ? 404 : 400 })
    }
    await life.db.prepare('UPDATE sandboxes SET egress_swap_mode = ? WHERE id = ?').bind(body.data.mode, row.id).run()
    const next = { ...row, egress_swap_mode: body.data.mode }
    // Leaving the firewall takes values out of the policy store: it fails closed if the write doesn't land.
    const applied = row.status === 'running' && row.session_id ? await applySandboxPolicy(life, next, 'mode_change') : null
    console.log(JSON.stringify({ event: 'egress_mode_set', sandboxId: row.id, mode: body.data.mode, applied: applied?.applied ?? false }))
    return Response.json({ sandboxId: row.id, mode: egressSwapModeFor(life, next), applied: applied?.applied ?? false })
  }
  // Dev only (probe 2, egress-docs): redacted facts about what Vercel holds for one sandbox, read with the
  // Worker's own token. Never a value or a body; anywhere but dev, these routes don't exist.
  const policyAudit = /^\/v1\/internal\/sandboxes\/([A-Za-z0-9_]+)\/(provider-policy-audit|provider-policy-scrub-test)$/.exec(path)
  if (policyAudit && life.config.environment === 'dev') {
    const row = await getSandbox(life.db, policyAudit[1]!)
    if (!row) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    if (policyAudit[2] === 'provider-policy-scrub-test' && request.method === 'POST') {
      const outcome = await scrubRecordPolicy(life, row)
      console.log(JSON.stringify({ event: 'provider_policy_scrub_test', sandboxId: row.id, outcome: typeof outcome === 'string' ? outcome : 'failed' }))
      return Response.json({ sandboxId: row.id, outcome })
    }
    if (policyAudit[2] === 'provider-policy-audit' && request.method === 'GET') {
      const marker = new URL(request.url).searchParams.get('marker') ?? ''
      if (marker.length < 12 || !marker.startsWith('orcaprobebogus')) {
        return Response.json({ error: 'invalid_marker' }, { status: 400 })
      }
      if (!life.provider.readRawForAudit) {
        return Response.json({ error: 'unsupported' }, { status: 501 })
      }
      const raw = await life.provider.readRawForAudit(row.provider_name)
      const facts = { state: raw.state, sessionStatus: raw.sessionStatus, record: policyFacts(raw.record, marker), session: raw.session === null ? null : policyFacts(raw.session, marker) }
      console.log(JSON.stringify({ event: 'provider_policy_audit', sandboxId: row.id, markerFound: facts.record.markerFound || Boolean(facts.session?.markerFound) }))
      return Response.json(facts)
    }
  }
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
      await audit(life.db, memberEventActor(body.data.accountId, body.data.userId, body.data.actorUserId), { action: 'member.role_changed', ...memberEventTarget(body.data.userId, body.data.actorUserId), detail: { role: body.data.role, keysUpdated: updated } }, now)
      return Response.json({ updated })
    }
    case 'POST /v1/internal/members/removed': {
      const body = MemberRemovedBody.safeParse(await deps.readJson())
      if (!body.success) {
        return Response.json({ error: 'invalid_request' }, { status: 400 })
      }
      // Same cleanup as /v1/internal/org-members/removed: whichever auth calls, nothing of theirs survives.
      const removal = await removeMember(life, body.data.accountId, body.data.userId, now, body.data.changedAt, body.data.actorUserId)
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
      } catch (error) {
        if (error instanceof SecretsKmsError) {
          return Response.json({ error: 'secrets_unavailable', reason: error.reason }, { status: 503, headers: noStore })
        }
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

const EgressModeBody = z.object({ mode: z.enum(['proxy', 'firewall']).nullable() })

/** Redacted facts about a raw provider body: rule counts and header NAMES only, plus a marker substring test. */
export function policyFacts(body: string, marker: string): { hasNetworkPolicy: boolean; transformRuleCount: number; headerNames: string[]; markerFound: boolean } {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(body)
  } catch {
    // Facts from the substring test only.
  }
  let hasNetworkPolicy = false
  let transformRuleCount = 0
  const headerNames = new Set<string>()
  const walk = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      if (/transform/i.test(key)) {
        transformRuleCount += value.length
      }
      value.forEach((item) => walk(item, key))
      return
    }
    if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        if (/^networkpolicy$/i.test(name)) {
          hasNetworkPolicy = true
        }
        if (/^headerNames$/i.test(name) && Array.isArray(child)) {
          for (const header of child) {
            if (typeof header === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(header)) {
              headerNames.add(header.toLowerCase())
            }
          }
        }
        walk(child, name)
      }
    }
  }
  walk(parsed, '')
  return { hasNetworkPolicy, transformRuleCount, headerNames: [...headerNames].sort(), markerFound: body.includes(marker) }
}
