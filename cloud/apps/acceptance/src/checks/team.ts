// Team create / invite against STAGING Orca Cloud auth (auth-staging.onorca.dev, PropelAuth test env)
// with the staging test accounts (cloud/dev/scripts/staging-test-accounts). Headless sign-in; the
// throwaway team is deleted afterwards. Tokens stay in a 0600 temp file and are never printed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log, type Check, type Ctx } from '../context'

const SCRIPTS = new URL('../../../../dev/scripts/staging-test-accounts/', import.meta.url).pathname

class SkipError extends Error {}

type Staging = { orgId: string; providerOrgId: string | null; token: string; createMs: number; tag: string }
let staging: Promise<Staging> | null = null

async function common(): Promise<any> {
  return import(`${SCRIPTS}common.mjs`)
}

function session(label: 'OWNER' | 'MEMBER'): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-stg-'))
  try {
    const file = join(dir, 's.json')
    execFileSync('node', [`${SCRIPTS}signin.mjs`, label, '--session-out', file], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180_000 })
    return (JSON.parse(readFileSync(file, 'utf8')) as { accessToken: string }).accessToken
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Dry run of the cleanup script: fails when the PropelAuth test-env key is unavailable. */
function cleanupAvailable(): boolean {
  try {
    execFileSync('node', [`${SCRIPTS}cleanup-teams.mjs`], { stdio: 'ignore', timeout: 120_000 })
    return true
  } catch {
    return false
  }
}

function team(ctx: Ctx): Promise<Staging> {
  staging ??= (async () => {
    if (!cleanupAvailable()) {
      throw new SkipError('staging team cleanup unavailable (no ~/.orca-secrets/staging-propelauth-api-key and gcloud needs re-login); not creating a team that could not be deleted')
    }
    const { orcaAuth } = await common()
    const token = session('OWNER')
    const tag = ctx.run.file.runId.replace(/[^0-9]/g, '').slice(-8)
    const t0 = performance.now()
    const created = await orcaAuth(token, 'POST', '/v1/desktop/orgs', { name: `W9 Acceptance ${tag}` })
    if (created.status !== 200) {
      throw new Error(`create team ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`)
    }
    ctx.run.created({ kind: 'other', id: created.body.orgId, label: 'staging team (deleted after)' })
    return { orgId: created.body.orgId, providerOrgId: created.body.providerOrgId ?? null, token, createMs: Math.round(performance.now() - t0), tag }
  })()
  return staging
}

/** Shared staging cleanup (cloud/dev/scripts/staging-test-accounts/cleanup-teams.mjs, #130), by explicit id. */
async function deleteTeam(ctx: Ctx, s: Staging): Promise<string> {
  try {
    execFileSync('node', [`${SCRIPTS}cleanup-teams.mjs`, '--yes', s.orgId], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
    ctx.run.destroyed('other', s.orgId)
    return 'deleted'
  } catch (error) {
    return `failed: ${String((error as { stderr?: Buffer }).stderr ?? error).split('\n').find(Boolean)?.slice(0, 160) ?? 'unknown'}`
  }
}

export const teamChecks: Record<string, Check> = {
  'team.create': async (ctx) => {
    const s = await team(ctx).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    if (s instanceof SkipError) {
      return { status: 'skipped', detail: s.message }
    }
    if (s instanceof Error) {
      throw s
    }
    const { orcaAuth } = await common()
    const roster = await orcaAuth(s.token, 'GET', `/v1/desktop/orgs/${s.orgId}/members`)
    const me = (roster.body?.members ?? []).find((m: any) => m.role === 'owner')
    const ok = roster.status === 200 && Boolean(me)
    return {
      status: ok ? 'pass' : 'fail',
      detail: `staging auth: team created in ${s.createMs} ms (headless PKCE sign-in as the OWNER test account); roster ${roster.status}, caller is ${me ? 'owner' : 'not owner'}`,
      timingsMs: { createTeam: s.createMs }
    }
  },

  'team.invite': async (ctx) => {
    const s = await team(ctx).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    if (s instanceof SkipError) {
      return { status: 'skipped', detail: s.message }
    }
    if (s instanceof Error) {
      throw s
    }
    const { orcaAuth } = await common()
    try {
      const email = `orca-w9+${s.tag}@example.com`
      const inv = await orcaAuth(s.token, 'POST', `/v1/desktop/orgs/${s.orgId}/invites`, { email, role: 'member' })
      const roster = await orcaAuth(s.token, 'GET', `/v1/desktop/orgs/${s.orgId}/members`)
      const pending = JSON.stringify(roster.body ?? '').includes(email)
      const memberToken = session('MEMBER')
      const outsider = await orcaAuth(memberToken, 'POST', `/v1/desktop/orgs/${s.orgId}/invites`, { email: `x+${s.tag}@example.com`, role: 'member' })
      const revoke = await orcaAuth(s.token, 'POST', `/v1/desktop/orgs/${s.orgId}/invites/revoke`, { email })
      const after = await orcaAuth(s.token, 'GET', `/v1/desktop/orgs/${s.orgId}/members`)
      const gone = !JSON.stringify(after.body ?? '').includes(email)
      const ok = inv.status < 300 && pending && outsider.status >= 400 && revoke.status < 300 && gone
      return {
        status: ok ? 'pass' : 'fail',
        detail: `invite ${inv.status} -> pending in roster=${pending}; non-member invite attempt -> ${outsider.status}; revoke ${revoke.status} -> gone=${gone}. Seat proration on accepted members: billing.seat-proration.`,
        evidence: [log('roster (counts)', JSON.stringify({ members: roster.body?.members?.length, invites: roster.body?.invites?.length ?? roster.body?.pendingInvites?.length }))]
      }
    } finally {
      // PropelAuth deletion needs gcloud (staging secret); if that is unavailable the team stays in the ledger as not destroyed.
      const del = await deleteTeam(ctx, s)
      ctx.run.note(`staging team ${s.orgId} delete -> ${del}`)
      staging = null
    }
  }
}
