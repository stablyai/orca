// W2 lifecycle + W3 networking checks on a dedicated workspace (status, OOM, wake, archive,
// share links, SSH keys, ports). Share-link cold load is also benchmarked here (n >= 10).
import { generateKeyPairSync } from 'node:crypto'
import { control } from '../clients'
import { config } from '../env'
import { log, type Check, type Ctx } from '../context'
import { orca, openTerminal } from '../orca-cli'
import { sandboxToken } from '../tokens'

const ARCHIVE = { 'x-orca-sandbox-features': 'archive' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let box: Promise<{ id: string; sessionId: string; code: string; root: string }> | null = null
function featureBox(ctx: Ctx) {
  box ??= (async () => {
    const r = await ctx.sandboxes.create(ctx.solo, { workspaceId: `w9-life-${ctx.run.file.runId}`, repo: { url: config.testRepo } })
    if (r.status !== 200) {
      throw new Error(`feature box create ${r.status} ${JSON.stringify(r.body)}`)
    }
    return { id: r.body.sandbox.id, sessionId: r.body.sandbox.session!.id, code: r.body.connection.pairingCode, root: r.body.connection.projectRoot }
  })()
  return box
}
async function refresh(ctx: Ctx): Promise<{ id: string; sessionId: string; code: string; root: string }> {
  const b = await featureBox(ctx)
  const g = await ctx.sandboxes.get(b.id)
  const next = { ...b, sessionId: g.body?.sandbox?.session?.id ?? b.sessionId }
  box = Promise.resolve(next)
  return next
}
const status = async (ctx: Ctx, id: string) => (await control.as(ctx.solo, 'GET', `/v1/sandboxes/${id}/status`)).body

/** Starts a tiny HTTP server on `port` inside the VM (survives the exec call). */
async function serve(ctx: Ctx, sessionId: string, port: number) {
  await ctx.exec(sessionId, `mkdir -p /tmp/www && echo "orca-share-ok" > /tmp/www/index.html && (cd /tmp/www && nohup python3 -m http.server ${port} >/tmp/www.log 2>&1 &) ; sleep 1; curl -s -m 5 localhost:${port}/`)
}

export const lifecycleChecks: Record<string, Check> = {
  'life.status': async (ctx) => {
    const b = await featureBox(ctx)
    const s = await status(ctx, b.id)
    const m = s?.status?.metrics
    const ok = s?.status?.state === 'ready' && m?.orcadAlive === true && typeof m?.cpuPercent === 'number' && m?.memTotalBytes > 0 && s?.status?.usage?.centsPerHour > 0
    return {
      status: ok ? 'pass' : 'fail',
      detail: `state ${s?.status?.state}; cpu ${m?.cpuPercent}% of ${m?.cpus}, mem ${Math.round((m?.memUsedBytes ?? 0) / 2 ** 20)}/${Math.round((m?.memTotalBytes ?? 0) / 2 ** 20)} MiB, disk ${Math.round((m?.diskUsedBytes ?? 0) / 2 ** 30)}/${Math.round((m?.diskTotalBytes ?? 0) / 2 ** 30)} GiB, orcadAlive ${m?.orcadAlive}; cost ${s?.status?.usage?.centsPerHour}¢/h. Restart covered by life.restart path in life.oom.`,
      evidence: [log('status', JSON.stringify(s?.status).slice(0, 1500))]
    }
  },

  'life.oom': async (ctx) => {
    const b = await featureBox(ctx)
    const before = (await status(ctx, b.id))?.status?.metrics?.oomKills ?? 0
    // A process that allocates past RAM; the kernel OOM killer takes it.
    await ctx.exec(b.sessionId, `python3 -c "x=[]\nwhile True: x.append(bytearray(256*1024*1024))" >/dev/null 2>&1; echo rc=$?`, 120_000).catch(() => null)
    const after = await status(ctx, b.id)
    const m = after?.status?.metrics
    const restart = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/restart`)
    if (restart.status === 200) {
      box = Promise.resolve({ ...b, sessionId: restart.body.sandbox.session.id, code: restart.body.connection.pairingCode })
    }
    const ok = (m?.oomKills ?? 0) > before && restart.status === 200
    return {
      status: ok ? 'pass' : (m?.oomKills ?? 0) > before ? 'partial' : 'fail',
      detail: `oomKills ${before} -> ${m?.oomKills} (victim ${m?.lastOomVictim ?? 'n/a'}), orcad survived=${m?.orcadAlive}; Restart -> ${restart.status} in ${restart.ms} ms. The banner + restart offer is desktop UI.`,
      timingsMs: { restart: restart.ms }
    }
  },

  'life.wake-on-message': async (ctx) => {
    const b = await refresh(ctx)
    const s = await ctx.sandboxes.suspend(b.id)
    const t0 = performance.now()
    const w = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/wake?wait=30s`)
    const wakeMs = Math.round(performance.now() - t0)
    const again = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/wake?wait=30s`)
    await refresh(ctx)
    const ok = s.status === 200 && w.body?.state === 'ready' && again.body?.state === 'ready' && again.ms < 3000
    return {
      status: ok ? 'partial' : 'fail',
      detail: `wake (idempotent, single-flight) on a slept workspace -> ${w.body?.state} in ${wakeMs} ms; second wake -> ${again.body?.state} in ${again.ms} ms. Message delivery after wake is covered by api.rest messages + desktop held typing.`,
      timingsMs: { wake: wakeMs, wakeAgain: again.ms }
    }
  },

  'life.idle-sleep': async () => {
    const r = await fetch(`${config.controlPlaneUrl}/v1/config`).then((x) => x.json()).catch(() => null)
    return {
      status: r?.idleSleepMinutes ? 'partial' : 'fail',
      detail: `GET /v1/config -> idleSleepMinutes ${r?.idleSleepMinutes} (Conductor: 20). Idle stop is driven by the desktop scheduler + lease lapse; a ${r?.idleSleepMinutes}-min idle wait is not part of the routine run.`
    }
  },

  'life.archive': async (ctx) => {
    const b = await refresh(ctx)
    await ctx.exec(b.sessionId, `echo arch > ${b.root}/.w9-arch; sync`)
    const a = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/archive`, {})
    const s = (await (await fetch(`${config.controlPlaneUrl}/v1/sandboxes/${b.id}/status`, { headers: { ...ARCHIVE, authorization: `Bearer ${await sandboxToken(ctx.solo)}` } })).json()) as any
    const meta = await control.as(ctx.solo, 'GET', `/v1/sandboxes/${b.id}/archive`)
    const u = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/unarchive`)
    let kept = false
    if (u.status === 200) {
      box = Promise.resolve({ ...b, sessionId: u.body.sandbox.session.id, code: u.body.connection.pairingCode })
      kept = (await ctx.exec(u.body.sandbox.session.id, `cat ${b.root}/.w9-arch`)).stdout.trim() === 'arch'
    }
    const ok = a.status === 200 && s?.status?.state === 'archived' && u.status === 200 && kept
    return {
      status: ok ? 'pass' : 'fail',
      detail: `archive ${a.status} in ${a.ms} ms -> state ${s?.status?.state}, expires ${s?.status?.archive?.expiresAt ? new Date(s.status.archive.expiresAt).toISOString().slice(0, 10) : 'n/a'}; archive metadata ${meta.body?.archive ? 'captured' : 'none'}; unarchive ${u.status} in ${u.ms} ms, files kept=${kept}`,
      timingsMs: { archive: a.ms, unarchive: u.ms }
    }
  },

  'acc.ports': async (ctx) => {
    const b = await refresh(ctx)
    await serve(ctx, b.sessionId, 4173)
    await openTerminal(b.code, b.root)
    let found: any = null
    for (let i = 0; i < 6 && !found; i++) {
      const r = await orca(b.code, ['ports', '--all'])
      found = JSON.stringify(r.json ?? '').includes('4173') ? r.json : null
      if (!found) {
        await sleep(2000)
      }
    }
    return {
      status: found ? 'pass' : 'fail',
      detail: found ? 'orca ports over the pairing sees port 4173 in the VM' : 'port 4173 not listed by orca ports',
      evidence: found ? [log('orca ports', JSON.stringify(found).slice(0, 1200))] : []
    }
  },

  'acc.share-link': async (ctx) => {
    const b = await refresh(ctx)
    await serve(ctx, b.sessionId, 4173)
    const samples: number[] = []
    const created: string[] = []
    let firstBody = ''
    for (let i = 0; i < 10; i++) {
      const s = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/shares`, { port: 4173, audience: 'public', expiresIn: '1h', allowWake: true })
      if (s.status !== 200 && s.status !== 201) {
        return { status: 'fail', detail: `create share ${s.status} ${JSON.stringify(s.body)}` }
      }
      created.push(s.body.share.id)
      const t0 = performance.now()
      const page = await fetch(s.body.share.url, { redirect: 'follow' })
      const text = await page.text()
      samples.push(Math.round(performance.now() - t0))
      firstBody ||= `${page.status} ${text.slice(0, 80)}`
    }
    ctx.run.bench('share.coldLoad', samples, 'first GET of a freshly created public share URL from this Mac (dev path-mode gateway)')
    // Asleep: the gateway shows a wake page instead of an error.
    await ctx.sandboxes.suspend(b.id)
    const lastUrl = (await control.as(ctx.solo, 'GET', `/v1/sandboxes/${b.id}/shares`)).body?.shares?.[0]?.url
    const asleep = lastUrl ? await fetch(lastUrl).then(async (r) => `${r.status} ${(await r.text()).includes('ake') ? 'wake page' : 'other'}`) : 'n/a'
    for (const id of created) {
      await control.as(ctx.solo, 'DELETE', `/v1/sandboxes/${b.id}/shares/${id}`)
    }
    const r = await ctx.sandboxes.resume(b.id)
    if (r.status === 200) {
      box = Promise.resolve({ ...b, sessionId: r.body.sandbox.session!.id, code: r.body.connection.pairingCode })
    }
    const ok = firstBody.startsWith('200') && firstBody.includes('orca-share-ok')
    return {
      status: ok ? 'pass' : 'fail',
      detail: `public share -> ${firstBody.slice(0, 40)}; cold load p50 ${[...samples].sort((x, y) => x - y)[4]} ms (n=10); while asleep -> ${asleep}`,
      evidence: [log('cold loads ms', samples.join(', '))]
    }
  },

  'acc.ssh': async (ctx) => {
    const b = await refresh(ctx)
    const { publicKey } = generateKeyPairSync('ed25519')
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
    const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]).toString('base64')
    const r = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/ssh-keys`, { publicKey: `ssh-ed25519 ${blob} w9-acceptance` })
    const listening = (await ctx.exec(b.sessionId, `ss -ltn 2>/dev/null | grep -c ":${r.body?.ssh?.port ?? 2222} " ; grep -c w9-acceptance ~/.ssh/authorized_keys 2>/dev/null`)).stdout.trim().split('\n')
    const ok = r.status === 200 && Number(listening[0]) > 0 && Number(listening[1]) > 0
    return {
      status: ok ? 'partial' : 'fail',
      detail: `ssh-keys ${r.status} -> port ${r.body?.ssh?.port}, user ${r.body?.ssh?.user}, host key ${r.body?.ssh?.hostKey ? 'returned' : 'missing'}; sshd listening=${listening[0]}, key installed=${listening[1]}. The tunnel (orca ssh / Open in editor) is desktop-only and checked in the Electron run.`
    }
  }
}
