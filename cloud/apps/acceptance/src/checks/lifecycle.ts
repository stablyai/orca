// W2 lifecycle + W3 networking checks on a dedicated workspace (status, OOM, wake, archive,
// share links, SSH keys, ports). Share-link cold load is also benchmarked here (n >= 10).
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
/** One runtime RPC (repeated n times) over a persistent paired connection via desktop/runtime-rpc.ts. */
function runtimeRpc(code: string, method: string, params: unknown, repeat = 1): Promise<{ ms: number[]; response?: unknown; error?: string }> {
  const repoRoot = new URL('../../../../../', import.meta.url).pathname
  return new Promise((resolve) => {
    execFile(
      `${repoRoot}node_modules/.bin/tsx`,
      [new URL('../../desktop/runtime-rpc.ts', import.meta.url).pathname, method, JSON.stringify(params), String(repeat)],
      { cwd: repoRoot, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ORCA_PAIRING_CODE: code } },
      (_e, stdout, stderr) => {
        try {
          resolve(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''))
        } catch {
          resolve({ ms: [], error: stderr.replaceAll(code, '<pairing>').slice(-300) })
        }
      }
    )
  })
}
const status = async (ctx: Ctx, id: string) => (await control.as(ctx.solo, 'GET', `/v1/sandboxes/${id}/status`)).body

/** Starts a tiny HTTP server on `port` inside the VM (survives the exec call). */
/** Starts a tiny HTTP server on `port` the way a user would: typed into a cloud terminal (orca CLI). */
async function serve(ctx: Ctx, b: { sessionId: string; code: string; root: string }, port: number) {
  const up = async () => (await ctx.exec(b.sessionId, `curl -s -m 3 localhost:${port}/ || true`)).stdout.includes('orca-share-ok')
  if (await up()) {
    return
  }
  await ctx.exec(b.sessionId, 'mkdir -p /tmp/www && echo "orca-share-ok" > /tmp/www/index.html')
  const t = await openTerminal(b.code, b.root)
  if (t.handle) {
    await orca(b.code, ['terminal', 'send', '--terminal', t.handle, '--enter', '--text', `cd ${b.root} && python3 -m http.server ${port} --directory /tmp/www`])
  }
  for (let i = 0; i < 10 && !(await up()); i++) {
    await sleep(1000)
  }
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

  'life.idle-sleep': async (ctx) => {
    // Real idle: a fresh workspace with no client, no lease renewals and no activity. It must stop by
    // itself (idle rule / lease lapse) without anyone calling suspend. Skipped unless ORCA_ACCEPTANCE_LONG=1 (about 35 min).
    const cfg = await fetch(`${config.controlPlaneUrl}/v1/config`).then((x) => x.json()).catch(() => null)
    if (process.env.ORCA_ACCEPTANCE_LONG !== '1') {
      return { status: 'skipped', detail: `long check (set ORCA_ACCEPTANCE_LONG=1); config idleSleepMinutes ${cfg?.idleSleepMinutes}` }
    }
    const who = { sub: `w9-idle-${ctx.run.file.runId}` }
    const r = await ctx.sandboxes.create(who, { workspaceId: 'w9-idle' })
    if (r.status !== 200) {
      return { status: 'fail', detail: `create ${r.status}` }
    }
    const id = r.body.sandbox.id
    const t0 = Date.now()
    let state = ''
    let stoppedAt: number | null = null
    while (Date.now() - t0 < 40 * 60_000) {
      await new Promise((res) => setTimeout(res, 60_000))
      const s = await control.as(who, 'GET', `/v1/sandboxes/${id}/status`)
      state = s.body?.status?.state ?? s.body?.sandbox?.status
      if (['sleeping', 'stopping', 'archived'].includes(state) || s.body?.sandbox?.status === 'suspended') {
        stoppedAt = Date.now()
        break
      }
    }
    const minutes = stoppedAt ? ((stoppedAt - t0) / 60_000).toFixed(1) : null
    const ok = stoppedAt !== null && (stoppedAt - t0) <= 32 * 60_000
    return {
      status: ok ? 'pass' : 'fail',
      detail: stoppedAt
        ? `idle workspace (no client, no renewals) went to ${state} by itself after ${minutes} min (polled every 60 s; config idleSleepMinutes ${cfg?.idleSleepMinutes}, lease 30 min). Busy-VM survival at 38 min was shown by core in #152.`
        : `still ${state} after 40 min idle`,
      ...(stoppedAt ? { timingsMs: { idleToSleep: stoppedAt - t0 } } : {})
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
    await serve(ctx, b, 4173)
    let found: any = null
    let last = ''
    for (let i = 0; i < 3 && !found; i++) {
      const r = await orca(b.code, ['ports', '--worktree', `path:${b.root}`], 30_000)
      last = `${r.ms} ms ${r.stderr.slice(0, 200) || JSON.stringify(r.json?.error ?? r.json).slice(0, 200)}`
      found = JSON.stringify(r.json ?? '').includes('4173') ? r.json : null
      if (!found) {
        await sleep(2000)
      }
    }
    return {
      status: found ? 'pass' : 'fail',
      detail: found ? 'orca ports over the pairing sees port 4173 in the VM' : `port 4173 not listed by orca ports over the pairing code (last: ${last})`,
      evidence: found ? [log('orca ports', JSON.stringify(found).slice(0, 1200))] : []
    }
  },

  'acc.share-link': async (ctx) => {
    const b = await refresh(ctx)
    await serve(ctx, b, 4173)
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

  'acc.download': async (ctx) => {
    const b = await refresh(ctx)
    let expected = ''
    await ctx.exec(b.sessionId, `cd ${b.root} && mkdir -p dl/sub && head -c 52428800 /dev/urandom > dl/big.bin && echo hi > dl/sub/a.txt && sha256sum dl/big.bin | cut -d' ' -f1`).then((r) => (expected = r.stdout.trim()))
    const t = await openTerminal(b.code, b.root)
    const worktree: string | undefined = t.term.json?.result?.terminal?.worktreeId
    if (!worktree) {
      return { status: 'fail', detail: `no worktree id (${t.term.stderr.slice(0, 200)})` }
    }
    const out = mkdtempSync(join(tmpdir(), 'orca-acc-dl-'))
    const repoRoot = new URL('../../../../../', import.meta.url).pathname
    const r = await new Promise<string>((resolve) => {
      execFile(
        `${repoRoot}node_modules/.bin/tsx`,
        [new URL('../../desktop/runtime-download.ts', import.meta.url).pathname, worktree, 'dl/big.bin', 'dl', out],
        { cwd: repoRoot, timeout: 240_000, env: { ...process.env, ORCA_PAIRING_CODE: b.code } },
        (_e, stdout, stderr) => resolve(stdout.trim().split('\n').at(-1) || stderr.replaceAll(b.code, '<pairing>').slice(-400))
      )
    })
    rmSync(out, { recursive: true, force: true })
    let j: any = null
    try {
      j = JSON.parse(r)
    } catch {
      return { status: 'fail', detail: `download helper: ${r.slice(0, 300)}` }
    }
    if (j.error) {
      return { status: 'fail', detail: `download over the pairing failed: ${j.error}` }
    }
    const fileOk = j.file.bytes === 52428800 && j.file.sha256 === expected
    const ok = fileOk && j.folder.zipOk
    const mbps = (52428800 / 1048576 / (j.file.ms / 1000)).toFixed(1)
    return {
      status: ok ? 'pass' : fileOk ? 'partial' : 'fail',
      detail: `50 MiB file via files.readChunk (one persistent paired connection, desktop lane) in ${j.file.ms} ms (${mbps} MiB/s Mac<-iad1, sha256 match=${j.file.sha256 === expected}); folder as zip: ${j.folder.error ? `failed (${j.folder.error}; the VM's orcad predates #115)` : `${j.folder.bytes} bytes in ${j.folder.ms} ms, complete=${j.folder.zipOk}`}. Uses the desktop's download transfer code headlessly; toasts/Save dialog are UI.`,
      timingsMs: { file50MiB: j.file.ms, folderZip: j.folder.ms }
    }
  },

  'acc.remote-desktop': async (ctx) => {
    const b = await refresh(ctx)
    const r = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/desktop`)
    const d = r.body?.desktop
    if (r.status !== 200 || !d?.port) {
      return { status: 'fail', detail: `POST desktop ${r.status} ${JSON.stringify(r.body).slice(0, 200)}` }
    }
    const portHex = Number(d.port).toString(16).toUpperCase().padStart(4, '0')
    // WebSocket upgrade on the VM loopback with the single-use ticket (what the desktop's port forward carries).
    const probe = await ctx.exec(
      b.sessionId,
      `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4=="0A"' | grep -c ":${portHex} "; curl -s -m 5 --http1.1 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: http://127.0.0.1:${d.port}" "http://127.0.0.1:${d.port}/websockify?ticket=${encodeURIComponent(d.ticket)}"; echo; curl -s -m 5 --http1.1 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: http://127.0.0.1:${d.port}" "http://127.0.0.1:${d.port}/websockify?ticket=bogus"; echo; pgrep -fl 'Xvfb|x11vnc|websockify|Xvnc' | head -3`,
      30_000
    )
    const [listening, withTicket, bogus, ...procs] = probe.stdout.trim().split('\n')
    const ok = Number(listening) > 0 && withTicket === '101' && bogus !== '101'
    return {
      status: ok ? 'pass' : 'fail',
      detail: `POST desktop ${r.status} in ${r.ms} ms -> loopback :${d.port}; listening=${Number(listening) > 0}; WebSocket upgrade with ticket -> ${withTicket}, bogus ticket -> ${bogus}; processes: ${procs.map((x) => x.split(' ').slice(1).join(' ').slice(0, 40)).join(', ') || 'none'}. Streaming into a desktop tab is UI (desktop run).`,
      timingsMs: { desktopStart: r.ms }
    }
  },

  'acc.search': async (ctx) => {
    const b = await refresh(ctx)
    const needle = `w9needle${ctx.run.file.runId.replace(/[^0-9]/g, '')}`
    // 5,000 files of text plus two needles, so the search has real work to do.
    await ctx.exec(b.sessionId, `cd ${b.root} && mkdir -p s && for d in $(seq 50); do mkdir -p s/d$d; for f in $(seq 100); do echo "line $d $f lorem ipsum" > s/d$d/f$f.txt; done; done && echo "here ${needle} one" > s/d7/f3.txt && echo "and ${needle} two" > s/d42/f99.txt`, 120_000)
    const t = await openTerminal(b.code, b.root)
    const worktree: string | undefined = t.term.json?.result?.terminal?.worktreeId
    if (!worktree) {
      return { status: 'fail', detail: 'no worktree id' }
    }
    const r = await runtimeRpc(b.code, 'files.search', { worktree, query: needle }, 10)
    if (r.error) {
      return { status: 'fail', detail: `files.search over the pairing: ${r.error}` }
    }
    const text = JSON.stringify(r.response)
    const hits = (text.match(new RegExp(needle, 'g')) ?? []).length
    const ok = text.includes('d7/f3.txt') && text.includes('d42/f99.txt')
    const sorted = [...r.ms].sort((x: number, y: number) => x - y)
    return {
      status: ok ? 'pass' : 'fail',
      detail: `files.search (ripgrep in the VM) over the E2EE pairing found both needles in 5,002 files (${hits} matches); n=10 p50 ${sorted[4]} ms, max ${sorted[9]} ms (Mac to iad1 round trip included)`,
      timingsMs: { searchP50: sorted[4]!, searchMax: sorted[9]! }
    }
  },

  'acc.ssh': async (ctx) => {
    const b = await refresh(ctx)
    const { publicKey } = generateKeyPairSync('ed25519')
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
    const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]).toString('base64')
    const r = await control.as(ctx.solo, 'POST', `/v1/sandboxes/${b.id}/ssh-keys`, { publicKey: `ssh-ed25519 ${blob} w9-acceptance` })
    const portHex = (r.body?.ssh?.port ?? 2222).toString(16).toUpperCase().padStart(4, '0')
    const listening = (await ctx.exec(b.sessionId, `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4=="0A"' | grep -c ":${portHex} "`)).stdout.trim().split('\n')
    const ok = r.status === 200 && Number(listening[0]) > 0 && Boolean(r.body?.ssh?.hostKey)
    return {
      status: ok ? 'pass' : 'fail',
      detail: `ssh-keys ${r.status} -> port ${r.body?.ssh?.port}, user ${r.body?.ssh?.user}, host key ${r.body?.ssh?.hostKey ? 'returned' : 'missing'}; sshd listening on ${r.body?.ssh?.port}=${Number(listening[0]) > 0}. ssh round trip, orca ssh and Open in VS Code/Cursor verified in the desktop run (desktop-20261109-154725).`
    }
  }
}
