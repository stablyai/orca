// W1 environment builds, W4 multiplayer, W5 public API / MCP / routines, W8 device sessions.
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createDecipheriv } from 'node:crypto'
import { SignJWT } from 'jose'
import { control } from '../clients'
import { config } from '../env'
import { log, type Check, type Ctx } from '../context'
import { orca } from '../orca-cli'
import type { Identity } from '../tokens'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tag = (ctx: Ctx) => ctx.run.file.runId.replace(/[^0-9]/g, '').slice(-10)

// ---------------- W1 environment builds ----------------
type BuildState = { envId: string; first: any; second: any; error?: string }
let builds: Promise<BuildState> | null = null

async function waitBuild(who: Identity, envId: string, buildId: string, timeoutMs = 25 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let b: any = null
  while (Date.now() < deadline) {
    b = (await control.as(who, 'GET', `/v1/environments/${envId}/builds/${buildId}`)).body?.build
    if (['succeeded', 'failed', 'canceled'].includes(b?.status)) {
      return b
    }
    await sleep(10_000)
  }
  return b
}

function environmentBuilds(ctx: Ctx): Promise<BuildState> {
  builds ??= (async () => {
    const who = ctx.owner
    const env = await control.as(who, 'POST', '/v1/environments', {
      name: `w9-acceptance-${tag(ctx)}`,
      repos: [{ url: config.testRepo }],
      installScript: 'echo "build-1 $(date -u +%s)" | sudo tee /opt/w9-build-marker >/dev/null',
      machineSize: 'standard'
    })
    if (env.status !== 200 && env.status !== 201) {
      return { envId: '', first: null, second: null, error: `create env ${env.status} ${JSON.stringify(env.body)}` }
    }
    const envId = env.body.environment.id
    ctx.run.created({ kind: 'other', id: envId, label: 'environment (deleted after)' })
    const b1 = await control.as(who, 'POST', `/v1/environments/${envId}/builds`)
    const first = b1.body?.build ? await waitBuild(who, envId, b1.body.build.id) : null
    if (first?.status !== 'succeeded') {
      return { envId, first, second: null, error: `build 1 ${b1.status} -> ${first?.status} ${first?.error ?? JSON.stringify(b1.body)} (step ${first?.failedStep})` }
    }
    await control.as(who, 'PATCH', `/v1/environments/${envId}`, { installScript: 'echo "build-2" | sudo tee /opt/w9-build-marker >/dev/null' })
    const b2 = await control.as(who, 'POST', `/v1/environments/${envId}/builds`)
    const second = b2.body?.build ? await waitBuild(who, envId, b2.body.build.id) : null
    return { envId, first, second }
  })()
  return builds
}

async function marker(ctx: Ctx, sessionId: string) {
  return (await ctx.exec(sessionId, 'cat /opt/w9-build-marker 2>/dev/null || echo none')).stdout.trim()
}

// ---------------- W4 / W8 crypto helpers ----------------
function x25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { privateKey, publicRaw: Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url') }
}

function openGrant(sealed: any, grantId: string, pair: ReturnType<typeof x25519Pair>): { pairingUrl: string } {
  const eph = Buffer.from(sealed.ephemeralPublicKeyB64, 'base64')
  const ephKey = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: eph.toString('base64url') }, format: 'jwk' })
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: ephKey })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, pair.publicRaw]), Buffer.from('orca-cloud-grant-v1'), 32))
  const ct = Buffer.from(sealed.ciphertextB64, 'base64')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonceB64, 'base64'))
  d.setAAD(Buffer.from(`orca-cloud-grant-v1:${grantId}`))
  d.setAuthTag(ct.subarray(ct.length - 16))
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'))
}

let teamWs: Promise<{ shared: string; priv: string }> | null = null
function teamWorkspaces(ctx: Ctx) {
  teamWs ??= (async () => {
    const a = await ctx.sandboxes.create(ctx.owner, { workspaceId: `w9-team-shared-${tag(ctx)}`, title: 'W9 shared', visibility: 'team', useEnvironment: false })
    const b = await ctx.sandboxes.create(ctx.owner, { workspaceId: `w9-team-private-${tag(ctx)}`, title: 'W9 private', visibility: 'private', useEnvironment: false })
    if (a.status !== 200 || b.status !== 200) {
      throw new Error(`team workspaces ${a.status}/${b.status} ${JSON.stringify(a.body).slice(0, 200)}`)
    }
    return { shared: a.body.sandbox.id, priv: b.body.sandbox.id }
  })()
  return teamWs
}

// ---------------- W5 API helpers ----------------
let apiKey: Promise<string> | null = null
function key(ctx: Ctx) {
  apiKey ??= (async () => {
    const r = await control.as(ctx.solo, 'POST', '/v1/api-keys', {
      name: `w9-${tag(ctx)}`,
      scopes: ['workspaces:read', 'workspaces:write', 'messages:write', 'projects:read', 'routines:read', 'routines:write'],
      expiresInDays: 1
    })
    if (!r.body?.secret) {
      throw new Error(`api key ${r.status} ${JSON.stringify(r.body)}`)
    }
    ctx.run.created({ kind: 'other', id: r.body.key?.id ?? 'api-key', label: 'API key (1 day, revoked after)' })
    return r.body.secret as string
  })()
  return apiKey
}
const api = async (ctx: Ctx, method: string, path: string, body?: unknown) => control.raw(method, path, await key(ctx), body)

export const platformChecks: Record<string, Check> = {
  'env.build': async (ctx) => {
    const s = await environmentBuilds(ctx)
    if (!s.first) {
      return { status: 'fail', detail: s.error ?? 'no build' }
    }
    const ok = s.first.status === 'succeeded'
    return {
      status: ok ? 'pass' : 'fail',
      detail: `org environment build 1 -> ${s.first.status} in ${Math.round((s.first.durationMs ?? 0) / 1000)} s (repo commit ${s.first.repos?.[0]?.commit?.slice(0, 7) ?? '?'})${s.error ? `; ${s.error}` : ''}`,
      timingsMs: { build: s.first.durationMs ?? 0 }
    }
  },

  'env.versions': async (ctx) => {
    const s = await environmentBuilds(ctx)
    if (!s.second) {
      return { status: 'fail', detail: s.error ?? 'second build missing' }
    }
    const list = await control.as(ctx.owner, 'GET', `/v1/environments/${s.envId}/builds`)
    const act = await control.as(ctx.owner, 'POST', `/v1/environments/${s.envId}/builds/${s.first.id}/activate`)
    const env = (await control.as(ctx.owner, 'GET', `/v1/environments/${s.envId}`)).body
    const ok = s.second.status === 'succeeded' && (list.body?.builds?.length ?? 0) >= 2 && act.status === 200 && env?.environment?.activeBuild?.id === s.first.id
    return {
      status: ok ? 'pass' : 'fail',
      detail: `build 2 -> ${s.second.status} (${Math.round((s.second.durationMs ?? 0) / 1000)} s); history ${list.body?.builds?.length} builds; activate older build 1 (rollback) -> ${act.status}, active=${env?.environment?.activeBuild?.id === s.first.id ? 'build 1' : env?.environment?.activeBuild?.id}`
    }
  },

  'env.from-build': async (ctx) => {
    const s = await environmentBuilds(ctx)
    if (!s.second) {
      return { status: 'fail', detail: s.error ?? 'builds missing' }
    }
    const r = await ctx.sandboxes.create(ctx.owner, { workspaceId: `w9-env-${tag(ctx)}`, repo: { url: config.testRepo }, environmentBuildId: s.second.id })
    if (r.status !== 200) {
      return { status: 'fail', detail: `create from build ${r.status} ${JSON.stringify(r.body)}` }
    }
    const m = await marker(ctx, r.body.sandbox.session!.id)
    await ctx.sandboxes.destroy(r.body.sandbox.id)
    const ok = m === 'build-2' && r.body.sandbox.environmentBuildId === s.second.id
    return { status: ok ? 'pass' : 'fail', detail: `create pinned to build 2 in ${r.ms} ms; install-script marker in VM: "${m}"`, timingsMs: { createFromBuild: r.ms } }
  },

  'env.pinned': async (ctx) => {
    const s = await environmentBuilds(ctx)
    if (!s.second) {
      return { status: 'fail', detail: s.error ?? 'builds missing' }
    }
    // Active build is build 1 now (env.versions). A workspace on build 2 must keep build 2 after a wake.
    const r = await ctx.sandboxes.create(ctx.owner, { workspaceId: `w9-pin-${tag(ctx)}`, repo: { url: config.testRepo }, environmentBuildId: s.second.id })
    if (r.status !== 200) {
      return { status: 'fail', detail: `create ${r.status}` }
    }
    await ctx.sandboxes.suspend(r.body.sandbox.id)
    const w = await ctx.sandboxes.resume(r.body.sandbox.id)
    const m = w.status === 200 ? await marker(ctx, w.body.sandbox.session!.id) : 'resume failed'
    const def = await ctx.sandboxes.create(ctx.owner, { workspaceId: `w9-default-${tag(ctx)}`, repo: { url: config.testRepo } })
    const dm = def.status === 200 ? await marker(ctx, def.body.sandbox.session!.id) : `create ${def.status}`
    await ctx.sandboxes.destroy(r.body.sandbox.id)
    if (def.status === 200) {
      await ctx.sandboxes.destroy(def.body.sandbox.id)
    }
    const ok = m === 'build-2' && dm.startsWith('build-1')
    return { status: ok ? 'pass' : 'fail', detail: `workspace pinned to build 2 still on "${m}" after wake; new default workspace uses active build: "${dm}"` }
  },

  'env.setup-script': async (ctx) => {
    const s = await environmentBuilds(ctx)
    const ok = s.first?.status === 'succeeded'
    // Teardown of the environment rides on the last env check.
    if (s.envId) {
      const d = await control.as(ctx.owner, 'DELETE', `/v1/environments/${s.envId}`)
      if (d.status === 200) {
        ctx.run.destroyed('other', s.envId)
      }
    }
    return { status: ok ? 'partial' : 'fail', detail: 'install script ran during the build (marker in env.from-build); per-repo orca.yaml setup on each new workspace runs through the desktop hook runtime (Electron run)' }
  },

  // ---------------- W4 ----------------
  'mp.registry': async (ctx) => {
    const ws = await teamWorkspaces(ctx)
    const list = await control.as(ctx.member, 'GET', '/v1/team/workspaces?scope=team')
    const views = list.body?.workspaces ?? []
    const shared = views.find((w: any) => w.id === ws.shared || w.sandboxId === ws.shared)
    const ok = list.status === 200 && shared?.access === 'can_open' && shared?.title === 'W9 shared'
    return { status: ok ? 'pass' : 'fail', detail: `member sees ${views.length} team workspace(s); shared one access=${shared?.access}, owner ${shared?.ownerUserId}`, evidence: [log('team list', JSON.stringify(views).slice(0, 1500))] }
  },

  'mp.private': async (ctx) => {
    const ws = await teamWorkspaces(ctx)
    const list = await control.as(ctx.member, 'GET', '/v1/team/workspaces?scope=team')
    const sees = JSON.stringify(list.body).includes(ws.priv)
    const direct = await control.as(ctx.member, 'GET', `/v1/team/workspaces/${ws.priv}`)
    const grant = await control.as(ctx.member, 'POST', `/v1/team/workspaces/${ws.priv}/grants`, { recipientPublicKeyB64: x25519Pair().publicRaw.toString('base64'), deviceLabel: 'w9', deviceKind: 'desktop' })
    const ok = !sees && direct.status === 404 && grant.status === 404
    return { status: ok ? 'pass' : 'fail', detail: `private workspace in member list=${sees}; direct GET ${direct.status}; grant ${grant.status}` }
  },

  'mp.teammate-open': async (ctx) => {
    const ws = await teamWorkspaces(ctx)
    const pair = x25519Pair()
    const g = await control.as(ctx.member, 'POST', `/v1/team/workspaces/${ws.shared}/grants`, { recipientPublicKeyB64: pair.publicRaw.toString('base64'), deviceLabel: 'w9-acceptance', deviceKind: 'desktop' })
    if (g.status !== 200 && g.status !== 201) {
      return { status: 'fail', detail: `grant ${g.status} ${JSON.stringify(g.body)}` }
    }
    const opened = openGrant(g.body.sealed, g.body.grant.id, pair)
    const st = await orca(opened.pairingUrl, ['status'])
    const presence = await control.as(ctx.member, 'POST', `/v1/team/workspaces/${ws.shared}/presence`, { clientId: 'w9-member-desktop', state: 'viewing' })
    const ownerView = await control.as(ctx.owner, 'GET', `/v1/team/workspaces/${ws.shared}`)
    const revoke = await control.as(ctx.member, 'DELETE', `/v1/team/workspaces/${ws.shared}/grants/${g.body.grant.id}`)
    const ok = st.ok && st.json?.result?.runtime?.state === 'ready'
    return {
      status: ok ? 'pass' : 'fail',
      detail: `member grant ${g.status} in ${g.ms} ms; sealed offer opened locally (X25519+HKDF+AES-GCM) -> orca CLI connected to the teammate's VM: ${st.json?.result?.runtime?.state ?? st.stderr.slice(0, 120)}; presence ${presence.status}, owner sees ${JSON.stringify(ownerView.body?.workspace?.presence ?? []).slice(0, 120)}; revoke ${revoke.status}`,
      timingsMs: { grant: g.ms, connect: st.ms }
    }
  },

  'mp.links': async (ctx) => {
    const ws = await teamWorkspaces(ctx)
    const r = await control.as(ctx.member, 'GET', `/v1/team/links/resolve?w=${ws.shared}`)
    const ok = r.status === 200 && JSON.stringify(r.body).includes(ws.shared)
    return { status: ok ? 'pass' : 'fail', detail: `links/resolve as teammate -> ${r.status}` }
  },

  'mp.cost': async (ctx) => {
    const ws = await teamWorkspaces(ctx)
    await sleep(2000)
    const list = await control.as(ctx.owner, 'GET', '/v1/team/workspaces?scope=mine')
    const w = (list.body?.workspaces ?? []).find((x: any) => x.id === ws.shared || x.sandboxId === ws.shared)
    const ok = typeof w?.cost?.computeMs === 'number' && typeof w?.cost?.totalUsdMicros === 'number'
    const dShared = await ctx.sandboxes.destroy(ws.shared)
    const dPriv = await ctx.sandboxes.destroy(ws.priv)
    void dShared
    void dPriv
    teamWs = null
    return { status: ok ? 'pass' : 'fail', detail: `cost in list: compute ${w?.cost?.computeMs} ms, $${((w?.cost?.totalUsdMicros ?? 0) / 1e6).toFixed(4)}` }
  },

  // ---------------- W5 ----------------
  'api.rest': async (ctx) => {
    const created = await api(ctx, 'POST', '/v1/workspaces', { name: `w9-api-${tag(ctx)}`, repo: config.testRepo })
    const id = created.body?.workspace?.id ?? created.body?.id
    if (!id) {
      return { status: 'fail', detail: `POST /v1/workspaces ${created.status} ${JSON.stringify(created.body).slice(0, 300)}` }
    }
    ctx.run.created({ kind: 'sandbox', id, label: 'public API workspace', vcpus: 4 })
    try {
      const get = await api(ctx, 'GET', `/v1/workspaces/${id}`)
      const slept = await api(ctx, 'POST', `/v1/workspaces/${id}/sleep`)
      const woke = await api(ctx, 'POST', `/v1/workspaces/${id}/wake`)
      const arch = await api(ctx, 'POST', `/v1/workspaces/${id}/archive`)
      const noKey = await control.raw('GET', '/v1/workspaces', 'orca_sk_' + 'x'.repeat(32))
      const ok = [200, 201, 202].includes(created.status) && get.status === 200 && slept.status < 300 && woke.status < 300 && arch.status < 300 && noKey.status === 401
      return {
        status: ok ? 'pass' : 'fail',
        detail: `API key: create ${created.status} (${created.ms} ms), get ${get.status} (${get.body?.workspace?.state ?? get.body?.state}), sleep ${slept.status} (${slept.ms} ms), wake ${woke.status} (${woke.ms} ms), archive ${arch.status}; bad key ${noKey.status}`,
        timingsMs: { create: created.ms, sleep: slept.ms, wake: woke.ms }
      }
    } finally {
      const d = await api(ctx, 'DELETE', `/v1/workspaces/${id}`)
      if (d.status < 300 || d.status === 404) {
        ctx.run.destroyed('sandbox', id)
      }
    }
  },

  'api.mcp': async (ctx) => {
    const rpc = (method: string, params: unknown, id: number) => api(ctx, 'POST', '/mcp', { jsonrpc: '2.0', id, method, params })
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'w9-acceptance', version: '1' } }, 1)
    const tools = await rpc('tools/list', {}, 2)
    const names = (tools.body?.result?.tools ?? []).map((t: any) => t.name)
    const call = await rpc('tools/call', { name: 'list_workspaces', arguments: {} }, 3)
    const ok = init.status === 200 && names.includes('create_workspace') && call.status === 200 && !call.body?.error
    return { status: ok ? 'pass' : 'fail', detail: `initialize ${init.status}; ${names.length} tools (${names.slice(0, 6).join(', ')}…); list_workspaces ${call.status}${call.body?.error ? ` ${JSON.stringify(call.body.error)}` : ''}` }
  },

  'api.cli': async () => ({
    status: 'partial',
    detail: 'CLI has `orca cloud env …` (builds) and `orca ssh`; creating a cloud workspace is via REST/MCP, not a CLI verb yet'
  }),

  'api.routine-webhook': async (ctx) => {
    const r = await api(ctx, 'POST', '/v1/routines', {
      name: `w9-hook-${tag(ctx)}`,
      repo: config.testRepo,
      trigger: { kind: 'webhook' },
      agent: 'claude',
      prompt: 'Reply with the single word ok. Do not change any files.',
      postResults: 'none',
      maxRuntimeMinutes: 5
    })
    if (!r.body?.webhookUrl) {
      return { status: 'fail', detail: `create routine ${r.status} ${JSON.stringify(r.body).slice(0, 300)}` }
    }
    const routineId = r.body.routine.id
    try {
      const hook = await fetch(r.body.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"from":"w9"}' })
      const hookBody = (await hook.json().catch(() => ({}))) as any
      const runId = hookBody?.run?.id ?? hookBody?.runId
      let run: any = null
      const deadline = Date.now() + 8 * 60_000
      while (runId && Date.now() < deadline) {
        run = (await api(ctx, 'GET', `/v1/routines/${routineId}/runs/${runId}`)).body?.run
        if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run?.status)) {
          break
        }
        await sleep(10_000)
      }
      const left = run?.workspaceId ? await control.as(ctx.solo, 'GET', `/v1/sandboxes/${run.workspaceId}`) : null
      const destroyed = !left || left.status === 404 || left.body?.sandbox?.status === 'destroyed'
      const ok = hook.status < 300 && ['succeeded', 'failed', 'timed_out'].includes(run?.status) && destroyed
      return {
        status: ok ? (run?.status === 'succeeded' ? 'pass' : 'partial') : 'fail',
        detail: `webhook ${hook.status} -> run ${run?.status ?? 'none'} on a fresh VM (${run?.result?.summary?.slice(0, 100) ?? run?.error ?? ''}); VM destroyed after: ${destroyed}`
      }
    } finally {
      await api(ctx, 'DELETE', `/v1/routines/${routineId}`)
    }
  },

  'api.routine-cron': async (ctx) => {
    const r = await api(ctx, 'POST', '/v1/routines', {
      name: `w9-cron-${tag(ctx)}`,
      repo: config.testRepo,
      trigger: { kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
      agent: 'claude',
      prompt: 'Reply ok.',
      postResults: 'none',
      enabled: false,
      maxRuntimeMinutes: 5
    })
    const id = r.body?.routine?.id
    const gh = await api(ctx, 'POST', '/v1/routines', {
      name: `w9-gh-${tag(ctx)}`,
      repo: config.testRepo,
      trigger: { kind: 'github', events: ['pull_request.opened'], labels: ['orca'] },
      agent: 'codex',
      prompt: 'Review.',
      postResults: 'comment',
      enabled: false,
      maxRuntimeMinutes: 5
    })
    for (const rid of [id, gh.body?.routine?.id].filter(Boolean)) {
      await api(ctx, 'DELETE', `/v1/routines/${rid}`)
    }
    const ok = (r.status === 201 || r.status === 200) && (gh.status === 201 || gh.status === 200)
    return { status: ok ? 'partial' : 'fail', detail: `weekday schedule routine ${r.status} (next ${r.body?.routine?.nextRunAt ? new Date(r.body.routine.nextRunAt).toISOString() : 'n/a'}); GitHub label-filtered routine ${gh.status}. Firing path verified by api.routine-webhook (same runner).` }
  },

  // ---------------- W8 ----------------
  'cli.mobile': async (ctx) => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64')
    const enroll = await control.as(ctx.solo, 'POST', '/v1/device-sessions', { label: 'w9 phone', platform: 'ios', publicKeyB64: pub })
    const ds = enroll.body?.deviceSession?.id
    if (!ds) {
      return { status: 'fail', detail: `enroll ${enroll.status} ${JSON.stringify(enroll.body)}` }
    }
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'EdDSA', kid: ds }).setIssuer('orca-device').setSubject(ds).setAudience('orca-sandbox').setIssuedAt().setExpirationTime('4m').sign(createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })))
    const p = (await ctx.primary()).sandbox.id
    const list = await control.raw('GET', '/v1/sandboxes', token)
    const wake = await control.raw('POST', `/v1/sandboxes/${p}/wake?wait=30s`, token)
    const secretsBlocked = await control.raw('GET', '/v1/secrets?scope=personal', token)
    const del = await control.as(ctx.solo, 'DELETE', `/v1/device-sessions/${ds}`)
    const after = await control.raw('GET', '/v1/sandboxes', token)
    const ok = list.status === 200 && wake.body?.state === 'ready' && secretsBlocked.status === 403 && del.status === 200 && after.status === 401
    return {
      status: ok ? 'pass' : 'fail',
      detail: `phone device session ${enroll.status}; as the phone: list ${list.status} (${list.body?.sandboxes?.length} ws), wake -> ${wake.body?.state} (${wake.ms} ms), secrets ${secretsBlocked.status}; revoke ${del.status} -> token ${after.status}. Mobile app UI checked by W8's own runs.`
    }
  }
}
