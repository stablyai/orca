// Secret store checks on the team account: write-only values, scope precedence, injection at session
// start (no rebuild). Only synthetic values; real keys never pass through these checks.
import { control } from '../clients'
import { log, type Check, type Ctx } from '../context'

const put = (ctx: Ctx, who: Ctx['owner'], scope: string, name: string, value: string) =>
  control.as(who, 'PUT', `/v1/secrets/${scope}/${name}`, { value })

async function orcadEnv(ctx: Ctx, sessionId: string, names: string[]): Promise<Record<string, string | null>> {
  const r = await ctx.exec(sessionId, `tr '\\0' '\\n' < /proc/$(cat ~/.orca-sandbox/orcad.pid)/environ`)
  const env = Object.fromEntries(
    r.stdout
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  )
  return Object.fromEntries(names.map((n) => [n, env[n] ?? null]))
}

let teamBox: Promise<{ id: string; sessionId: string }> | null = null
function teamSandbox(ctx: Ctx) {
  teamBox ??= (async () => {
    const tag = ctx.run.file.runId
    await put(ctx, ctx.owner, 'org', 'W9_SHARED', `org-${tag}`)
    await put(ctx, ctx.owner, 'org', 'W9_OVERRIDE', `org-${tag}`)
    await put(ctx, ctx.owner, 'org', 'AWS_REGION', `org-fake-${tag}`)
    await put(ctx, ctx.member, 'personal', 'W9_OVERRIDE', `personal-${tag}`)
    await put(ctx, ctx.member, 'personal', 'AWS_REGION', `personal-fake-${tag}`)
    const r = await ctx.sandboxes.create(ctx.member, { workspaceId: `w9-team-${tag}` })
    if (r.status !== 200) {
      throw new Error(`team sandbox create ${r.status} ${JSON.stringify(r.body)}`)
    }
    return { id: r.body.sandbox.id, sessionId: r.body.sandbox.session!.id }
  })()
  return teamBox
}

export const secretChecks: Record<string, Check> = {
  'sec.reserved': async (ctx) => {
    const names = ['PATH', 'GH_TOKEN', 'ORCA_ANYTHING', 'CLAUDE_CODE_OAUTH_TOKEN', 'LD_PRELOAD']
    const statuses = await Promise.all(names.map(async (n) => [n, (await put(ctx, ctx.solo, 'personal', n, 'x')).status] as const))
    const ok = statuses.every(([, s]) => s === 400)
    return { status: ok ? 'pass' : 'fail', detail: statuses.map(([n, s]) => `${n}=${s}`).join(', ') }
  },

  'sec.org-secret': async (ctx) => {
    const tag = ctx.run.file.runId
    const memberWrite = await put(ctx, ctx.member, 'org', 'W9_MEMBER_TRY', 'nope')
    const box = await teamSandbox(ctx)
    const list = await control.as(ctx.member, 'GET', '/v1/secrets?scope=org')
    const listed = JSON.stringify(list.body)
    const hidden = !listed.includes(`org-${tag}`) && /W9_SHARED/.test(listed)
    const env = await orcadEnv(ctx, box.sessionId, ['W9_SHARED'])
    const ok = memberWrite.status === 403 && hidden && env.W9_SHARED === `org-${tag}`
    return {
      status: ok ? 'pass' : 'fail',
      detail: `member write to org -> ${memberWrite.status}; list shows name without value: ${hidden}; injected into VM: ${env.W9_SHARED === `org-${tag}`}`,
      evidence: [log('org list (metadata only)', listed.slice(0, 1200))]
    }
  },

  'sec.precedence': async (ctx) => {
    const tag = ctx.run.file.runId
    const box = await teamSandbox(ctx)
    const env = await orcadEnv(ctx, box.sessionId, ['W9_OVERRIDE', 'AWS_REGION'])
    const personalWinsEnv = env.W9_OVERRIDE === `personal-${tag}`
    const orgWinsAgentKey = env.AWS_REGION === `org-fake-${tag}`
    return {
      status: personalWinsEnv && orgWinsAgentKey ? 'pass' : 'fail',
      detail: `env: personal beats org = ${personalWinsEnv}; agent key: org beats personal = ${orgWinsAgentKey}`
    }
  },

  'sec.no-rebuild': async (ctx) => {
    const tag = ctx.run.file.runId
    const box = await teamSandbox(ctx)
    await put(ctx, ctx.owner, 'org', 'W9_SHARED', `org2-${tag}`)
    const s = await ctx.sandboxes.suspend(box.id)
    const r = await ctx.sandboxes.resume(box.id)
    if (r.status !== 200) {
      return { status: 'fail', detail: `suspend ${s.status} resume ${r.status}` }
    }
    const env = await orcadEnv(ctx, r.body.sandbox.session!.id, ['W9_SHARED'])
    for (const [scope, who, name] of [
      ['org', ctx.owner, 'W9_SHARED'],
      ['org', ctx.owner, 'W9_OVERRIDE'],
      ['org', ctx.owner, 'AWS_REGION'],
      ['personal', ctx.member, 'W9_OVERRIDE'],
      ['personal', ctx.member, 'AWS_REGION']
    ] as const) {
      await control.as(who, 'DELETE', `/v1/secrets/${scope}/${name}`)
    }
    await ctx.sandboxes.destroy(box.id)
    teamBox = null
    const ok = env.W9_SHARED === `org2-${tag}`
    return { status: ok ? 'pass' : 'fail', detail: `changed org secret visible after wake without rebuild: ${ok} (wake ${r.ms} ms)` }
  }
}
