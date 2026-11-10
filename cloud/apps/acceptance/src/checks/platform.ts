// W1 environment builds, W4 multiplayer, W5 public API / MCP / routines, W8 device sessions.
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createDecipheriv } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { control } from '../clients'
import { config, secrets } from '../env'
import { log, type Check, type Ctx } from '../context'
import { orca } from '../orca-cli'
import { sandboxToken, type Identity } from '../tokens'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tag = (ctx: Ctx) => ctx.run.file.runId.replace(/[^0-9]/g, '').slice(-10)

// ---------------- W1 environment builds ----------------
type BuildState = { envId: string; first: any; second: any; error?: string }
let builds: Promise<BuildState> | null = null

/**
 * Polls GET only by default: builds must progress server-side with nobody streaming (the W1-1 bug).
 * ORCA_ACCEPTANCE_BUILD_EVENTS=1 follows the live NDJSON events the way the desktop does.
 */
async function waitBuild(who: Identity, envId: string, buildId: string, timeoutMs = 25 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let b: any = null
  while (process.env.ORCA_ACCEPTANCE_BUILD_EVENTS !== '1' && Date.now() < deadline) {
    b = (await control.as(who, 'GET', `/v1/environments/${envId}/builds/${buildId}`)).body?.build
    if (['succeeded', 'failed', 'canceled'].includes(b?.status)) {
      return b
    }
    await sleep(5000)
  }
  while (Date.now() < deadline) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), Math.min(5 * 60_000, deadline - Date.now()))
    try {
      const r = await fetch(`${config.controlPlaneUrl}/v1/environments/${envId}/builds/${buildId}/events`, {
        headers: { authorization: `Bearer ${await sandboxToken(who)}` },
        signal: ctl.signal
      })
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines.filter(Boolean)) {
          const e = JSON.parse(line)
          if (e.type === 'build') {
            b = e.build
          }
        }
        if (['succeeded', 'failed', 'canceled'].includes(b?.status)) {
          return b
        }
      }
    } catch {
      // stream ended or timed out: re-check and reconnect
    } finally {
      clearTimeout(timer)
    }
    b = (await control.as(who, 'GET', `/v1/environments/${envId}/builds/${buildId}`)).body?.build ?? b
    if (['succeeded', 'failed', 'canceled'].includes(b?.status)) {
      return b
    }
    await sleep(2000)
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

function onceSoonCron(): string {
  const at = new Date(Date.now() + 2 * 60_000)
  return `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`
}
const routineWebhook = (ctx: Ctx) => platformChecks['api.routine-webhook-impl']!(ctx)

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
    const ok = s.second.status === 'succeeded' && (list.body?.builds?.length ?? 0) >= 2 && act.status === 200 && env?.environment?.activeBuildId === s.first.id
    return {
      status: ok ? 'pass' : 'fail',
      detail: `build 2 -> ${s.second.status} (${Math.round((s.second.durationMs ?? 0) / 1000)} s); history ${list.body?.builds?.length} builds; activate older build 1 (rollback) -> ${act.status}, active=${env?.environment?.activeBuildId === s.first.id ? 'build 1' : env?.environment?.activeBuildId}`
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
    // Per-repo orca.yaml scripts.setup runs inside the VM on a workspace created through the API
    // (core #168): exactly once, even across a sleep/wake. Uses branch w9-setup-script of the test
    // repo, whose orca.yaml appends one line to .w9-setup-marker per run.
    // Teardown of the environment the env.* checks built rides on this, the last env check.
    if (builds) {
      const s = await builds
      if (s.envId) {
        const d = await control.as(ctx.owner, 'DELETE', `/v1/environments/${s.envId}`)
        if (d.status === 200) {
          ctx.run.destroyed('other', s.envId)
        }
      }
    }
    const created = await api(ctx, 'POST', '/v1/workspaces', { name: `w9-setup-${tag(ctx)}`, repo: { url: config.testRepo, ref: 'w9-setup-script' } })
    const id = created.body?.workspace?.id ?? created.body?.id
    if (!id) {
      return { status: 'fail', detail: `create ${created.status} ${JSON.stringify(created.body).slice(0, 200)}` }
    }
    ctx.run.created({ kind: 'sandbox', id, label: 'orca.yaml setup workspace', vcpus: 4 })
    try {
      const session = async () => (await control.as(ctx.solo, 'GET', `/v1/sandboxes/${id}`)).body?.sandbox?.session?.id as string
      const read = async (sid: string) =>
        (await ctx.sandboxes.exec(sid, `cd /vercel/sandbox/project && echo "lines=$(wc -l < .w9-setup-marker 2>/dev/null || echo 0)"; cat ~/.orca-sandbox/project-setup/exit* 2>/dev/null | head -1; ls ~/.orca-sandbox/project-setup/ 2>/dev/null | tr '\\n' ' '`)).stdout
      let out = ''
      const t0 = Date.now()
      while (Date.now() - t0 < 120_000) {
        out = await read(await session())
        if (/lines=[1-9]/.test(out)) {
          break
        }
        await sleep(3000)
      }
      const ranMs = Date.now() - t0
      const first = Number(/lines=(\d+)/.exec(out)?.[1] ?? 0)
      // Sleep and wake: the setup must not run again.
      await api(ctx, 'POST', `/v1/workspaces/${id}/sleep`)
      await api(ctx, 'POST', `/v1/workspaces/${id}/wake`)
      await sleep(10_000)
      const again = await read(await session())
      const second = Number(/lines=(\d+)/.exec(again)?.[1] ?? 0)
      const ok = first === 1 && second === 1
      return {
        status: ok ? 'pass' : 'fail',
        detail: `orca.yaml scripts.setup ran inside the VM for an API-created workspace (${first} run within ${Math.round(ranMs / 1000)} s; log dir: ${out.split('\n').slice(1).join(' ').trim().slice(0, 120)}); after sleep/wake still ${second} run (exactly once). Desktop-created workspaces run setup after the trust prompt (UI). The environment-build skip path is unit-tested by core.`,
        timingsMs: { setupVisible: ranMs }
      }
    } finally {
      const d = await api(ctx, 'DELETE', `/v1/workspaces/${id}`)
      if (d.status < 300 || d.status === 404) {
        ctx.run.destroyed('sandbox', id)
      }
    }
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
    const created = await api(ctx, 'POST', '/v1/workspaces', { name: `w9-api-${tag(ctx)}`, repo: { url: config.testRepo } })
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

  'life.wake-on-message': async (ctx) => {
    // A message sent to a SLEEPING workspace through the public API wakes it and is delivered to the
    // agent (Claude Code via the shared gateway key, kimi-k2): the Conductor 0.81/0.83 behaviour.
    const gw = secrets.aiGatewayKey()
    if (!gw) {
      return { status: 'skipped', detail: 'no AI Gateway key' }
    }
    const agentEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh',
      ANTHROPIC_AUTH_TOKEN: gw,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2'
    }
    for (const [name, value] of Object.entries(agentEnv)) {
      await control.as(ctx.solo, 'PUT', `/v1/secrets/personal/${name}`, { value })
    }
    const created = await api(ctx, 'POST', '/v1/workspaces', { name: `w9-wakemsg-${tag(ctx)}` })
    const id = created.body?.workspace?.id ?? created.body?.id
    if (!id) {
      return { status: 'fail', detail: `create ${created.status} ${JSON.stringify(created.body).slice(0, 200)}` }
    }
    ctx.run.created({ kind: 'sandbox', id, label: 'wake-on-message workspace', vcpus: 4 })
    try {
      const slept = await api(ctx, 'POST', `/v1/workspaces/${id}/sleep`)
      const t0 = Date.now()
      const sent = await api(ctx, 'POST', `/v1/workspaces/${id}/messages`, { text: 'Reply with exactly: WOKE-AND-DELIVERED', agent: 'claude' })
      const mid = sent.body?.message?.id ?? sent.body?.id
      let message: any = null
      while (mid && Date.now() - t0 < 120_000) {
        message = (await api(ctx, 'GET', `/v1/workspaces/${id}/messages/${mid}`)).body?.message
        if (['delivered', 'failed'].includes(message?.status)) {
          break
        }
        await sleep(1000)
      }
      const deliveredMs = Date.now() - t0
      const ws = (await api(ctx, 'GET', `/v1/workspaces/${id}`)).body
      const state = ws?.workspace?.state ?? ws?.state
      const ok = slept.status < 300 && sent.status === 202 && message?.status === 'delivered'
      return {
        status: ok ? 'pass' : 'fail',
        detail: `workspace slept (${slept.status}); message POSTed while asleep -> ${sent.status}; ${message?.status ?? 'no message'}${message?.error ? ` (${message.error})` : ''} after ${deliveredMs} ms (woke the VM and handed the prompt to Claude Code); workspace now ${state}`,
        timingsMs: { sleepToDelivered: deliveredMs }
      }
    } finally {
      for (const name of Object.keys(agentEnv)) {
        await control.as(ctx.solo, 'DELETE', `/v1/secrets/personal/${name}`)
      }
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

  'api.cli': async (ctx) => {
    // `orca worktree create --on cloud` (W5 #167), headless: the CLI calls the control plane with an
    // API key (no app involved). Needs out/cli/index.js built from this checkout.
    const repoRoot = new URL('../../../../../', import.meta.url).pathname
    const cli = `${repoRoot}out/cli/index.js`
    if (!existsSync(cli)) {
      return { status: 'skipped', detail: 'out/cli/index.js not built (node config/scripts/cli-build/build-cli.mjs)' }
    }
    const credDir = mkdtempSync(join(tmpdir(), 'orca-cli-cred-'))
    const run = (args: string[], env: Record<string, string>) =>
      new Promise<{ code: number; json: any; ms: number; stderr: string }>((resolve) => {
        const t0 = Date.now()
        execFile('node', [cli, ...args], { cwd: repoRoot, timeout: 180_000, env: { ...process.env, ORCA_CLOUD_CREDENTIALS_FILE: join(credDir, 'credentials.json'), ...env } }, (e, stdout, stderr) => {
          let json: any = null
          try {
            json = JSON.parse(stdout)
          } catch {
            json = null
          }
          resolve({ code: e ? (typeof (e as any).code === 'number' ? (e as any).code : 1) : 0, json, ms: Date.now() - t0, stderr: stderr.slice(0, 300) })
        })
      })
    try {
      const signedOut = await run(['worktree', 'create', '--on', 'cloud', '--name', 'w9-cli-noauth', '--json'], { ORCA_CLOUD_TOKEN: '', ORCA_CLOUD_API_URL: '' })
      const env = { ORCA_CLOUD_TOKEN: await key(ctx), ORCA_CLOUD_API_URL: config.controlPlaneUrl }
      const created = await run(['worktree', 'create', '--on', 'cloud', '--name', `w9-cli-${tag(ctx)}`, '--repo', config.testRepo, '--json'], env)
      const ws = created.json?.result?.workspace
      if (ws?.id) {
        ctx.run.created({ kind: 'sandbox', id: ws.id, label: 'CLI --on cloud workspace', vcpus: 4 })
      }
      const destroyed = ws?.id ? await run(['cloud', 'workspace', 'destroy', ws.id, '--json'], env) : null
      if (ws?.id && destroyed?.code === 0) {
        ctx.run.destroyed('sandbox', ws.id)
      } else if (ws?.id) {
        await api(ctx, 'DELETE', `/v1/workspaces/${ws.id}`)
        ctx.run.destroyed('sandbox', ws.id)
      }
      const notSignedIn = JSON.stringify(signedOut.json ?? signedOut.stderr).includes('cloud_not_signed_in')
      const ok = created.code === 0 && ws?.status === 'running' && created.json?.result?.host?.origin?.target === 'cloud' && destroyed?.code === 0 && notSignedIn
      return {
        status: ok ? 'pass' : 'fail',
        detail: `orca worktree create --on cloud --repo … (API key) -> ${ws?.status ?? `exit ${created.code} ${created.stderr || JSON.stringify(created.json?.error ?? '').slice(0, 120)}`} in ${created.ms} ms; cloud workspace destroy -> exit ${destroyed?.code}; signed out -> ${notSignedIn ? 'cloud_not_signed_in' : `unexpected ${JSON.stringify(signedOut.json?.error ?? signedOut.stderr).slice(0, 120)}`}`,
        timingsMs: { cliCreate: created.ms }
      }
    } finally {
      rmSync(credDir, { recursive: true, force: true })
    }
  },

  'api.routine-webhook': async (ctx) => {
    // Routine runs act with the creator's credentials: give the account the gateway key the product way.
    const gw = secrets.aiGatewayKey()
    const agentEnv: Record<string, string> = gw
      ? { ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh', ANTHROPIC_AUTH_TOKEN: gw, ANTHROPIC_MODEL: 'moonshotai/kimi-k2', ANTHROPIC_SMALL_FAST_MODEL: 'openai/gpt-5-nano' }
      : {}
    for (const [name, value] of Object.entries(agentEnv)) {
      await control.as(ctx.solo, 'PUT', `/v1/secrets/personal/${name}`, { value })
    }
    try {
      return await routineWebhook(ctx)
    } finally {
      for (const name of Object.keys(agentEnv)) {
        await control.as(ctx.solo, 'DELETE', `/v1/secrets/personal/${name}`)
      }
    }
  },

  'api.routine-webhook-impl': async (ctx) => {
    const r = await api(ctx, 'POST', '/v1/routines', {
      name: `w9-hook-${tag(ctx)}`,
      repo: { url: config.testRepo },
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
    // A schedule routine fires by itself on a fresh VM, runs the agent, and destroys the VM. Dev allows
    // an every-minute cron; GitHub-trigger creation (label/author/base filters) is checked too.
    const gw = secrets.aiGatewayKey()
    const agentEnv: Record<string, string> = gw
      ? { ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh', ANTHROPIC_AUTH_TOKEN: gw, ANTHROPIC_MODEL: 'moonshotai/kimi-k2', ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2' }
      : {}
    for (const [name, value] of Object.entries(agentEnv)) {
      await control.as(ctx.solo, 'PUT', `/v1/secrets/personal/${name}`, { value })
    }
    const ids: string[] = []
    try {
      const r = await api(ctx, 'POST', '/v1/routines', {
        name: `w9-cron-${tag(ctx)}`,
        repo: { url: config.testRepo },
        // Fires exactly once in the run: the UTC minute two minutes from now (daily cron).
        trigger: { kind: 'schedule', cron: onceSoonCron(), timezone: 'UTC' },
        agent: 'claude',
        prompt: 'Reply with the single word ok. Do not change any files.',
        postResults: 'none',
        enabled: true,
        maxRuntimeMinutes: 5
      })
      if (r.body?.routine?.id) {
        ids.push(r.body.routine.id)
      }
      const gh = await api(ctx, 'POST', '/v1/routines', {
        name: `w9-gh-${tag(ctx)}`,
        repo: { url: config.testRepo },
        trigger: { kind: 'github', events: ['pull_request.opened'], labels: ['orca'], baseBranches: ['main'] },
        agent: 'codex',
        prompt: 'Review.',
        postResults: 'comment',
        enabled: false,
        maxRuntimeMinutes: 5
      })
      if (gh.body?.routine?.id) {
        ids.push(gh.body.routine.id)
      }
      if (!r.body?.routine?.id) {
        return { status: 'fail', detail: `create schedule routine ${r.status} ${JSON.stringify(r.body).slice(0, 200)}` }
      }
      const id = r.body.routine.id
      const t0 = Date.now()
      // Wait for the scheduler to start the FIRST run on its own (cron every minute), disable the
      // routine at once so it fires only once, then follow that run to the end.
      let first: any = null
      while (!first && Date.now() - t0 < 6 * 60_000) {
        const runs = (await api(ctx, 'GET', `/v1/routines/${id}/runs?limit=20`)).body?.runs ?? []
        first = runs.at(-1) ?? null
        if (!first) {
          await sleep(5_000)
        }
      }
      const firedAfterMs = first ? Date.now() - t0 : null
      let run: any = first
      while (first && Date.now() - t0 < 12 * 60_000) {
        run = (await api(ctx, 'GET', `/v1/routines/${id}/runs/${first.id}`)).body?.run ?? run
        if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run?.status)) {
          break
        }
        await sleep(10_000)
      }
      await sleep(5_000)
      const left = run?.workspaceId ? await control.as(ctx.solo, 'GET', `/v1/sandboxes/${run.workspaceId}`) : null
      const destroyed = !left || left.status === 404 || left.body?.sandbox?.status === 'destroyed'
      const firedAfter = firedAfterMs !== null ? Math.round(firedAfterMs / 1000) : null
      const ok = run?.status === 'succeeded' && destroyed && (gh.status === 201 || gh.status === 200)
      return {
        status: ok ? 'pass' : run ? 'partial' : 'fail',
        detail: `daily schedule set 2 min ahead fired on its own ${firedAfter ?? '?'} s after creation -> first run ${run?.status ?? 'none within 5 min'} on a fresh VM (${String(run?.result?.summary ?? run?.error ?? '').slice(0, 80)}); VM destroyed after: ${destroyed}; GitHub-trigger routine with label/base filters -> ${gh.status}`
      }
    } finally {
      for (const rid of ids) {
        await api(ctx, 'DELETE', `/v1/routines/${rid}`)
      }
      for (const name of Object.keys(agentEnv)) {
        await control.as(ctx.solo, 'DELETE', `/v1/secrets/personal/${name}`)
      }
    }
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
