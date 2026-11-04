// R2: does a deploy keep sockets? Runs the load, then runs --deploy-cmd, then watches drops and
// which sampled host objects have adopted the new version.
//
// Cloudflare (see CF-RUNBOOK.md):
//   tsx spike/deploy-under-load.ts --url https://orca-relay-edge-spike.<sub>.workers.dev \
//     --hosts 1000 --phones 50 --warmup 120 --observe 900 --new-version v2 \
//     --deploy-cmd "npx wrangler deploy --env spike --var EDGE_VERSION:v2 --durable-objects-code-update-mode 'deferred 120s'"
// Expectation for a pass: no idle-host drops; hosts with live splices may drop only after
// ~max_delay (120 s); sampled idle hosts report the new version after their next wake.
import { spawn } from 'node:child_process'
import { LOAD_DEFAULTS, runLoad } from './load-hosts'
import { emit, hostInfo, parseArgs, setEventFile, sleep } from './lib'

const a = parseArgs({ ...LOAD_DEFAULTS, warmup: '120', observe: '900', sample: '20', 'new-version': 'v2', 'deploy-cmd': '' })
if (!a['deploy-cmd']) {
  console.error('--deploy-cmd is required (see header for the Cloudflare command)')
  process.exit(2)
}
setEventFile(a.out || null)
const url = a.url.replace(/\/$/, '')
const load = await runLoad(a)
emit({ kind: 'warmup', seconds: Number(a.warmup) })
await sleep(Number(a.warmup) * 1000)
const before = load.drops.length
const t0 = Date.now()
emit({ kind: 'deploy_start', cmd: a['deploy-cmd'] })
const code = await new Promise<number>((resolve) => {
  const child = spawn(a['deploy-cmd'], { shell: true, stdio: 'inherit' })
  child.on('exit', (c) => resolve(c ?? 1))
})
emit({ kind: 'deploy_done', exitCode: code, seconds: (Date.now() - t0) / 1000 })

// Sample: half from hosts with phones (live splices), half idle hosts.
const nPhones = Math.min(Number(a.phones), load.hosts.length)
const sorted = [...load.hosts].sort((x, y) => x.index - y.index)
const half = Math.floor(Number(a.sample) / 2)
const sample = [...sorted.slice(0, Math.min(half, nPhones)), ...sorted.slice(nPhones, nPhones + half)]
const adoptedAt = new Map<number, number>()
const end = t0 + Number(a.observe) * 1000
while (Date.now() < end) {
  await Promise.all(
    sample.map(async (h) => {
      if (adoptedAt.has(h.index)) return
      const info = await hostInfo(url, h.relayHostId)
      if (info?.version === a['new-version']) adoptedAt.set(h.index, (Date.now() - t0) / 1000)
    })
  )
  emit({ kind: 'adoption', seconds: Math.round((Date.now() - t0) / 1000), adopted: adoptedAt.size, sample: sample.length }, true)
  // Keep observing the full window: active splices only reset once max_delay expires.
  await sleep(10_000)
}

// Settle: how long until every host is live again (if any dropped).
const settleEnd = Date.now() + 120_000
while (Date.now() < settleEnd && load.hosts.some((h) => !h.live())) await sleep(1000)
const allLiveAfterSec = load.hosts.every((h) => h.live()) ? Math.round((Date.now() - t0) / 1000) : null

const after = load.drops.slice(before).filter((d) => d.t >= t0)
const report = {
  deployExit: code,
  allLiveAfterSec,
  dropsAfterDeploy: after.length,
  idleHostDrops: after.filter((d) => d.who === 'host' && d.index >= nPhones).length,
  splicedHostDrops: after.filter((d) => d.who === 'host' && d.index < nPhones).length,
  phoneDrops: after.filter((d) => d.who === 'phone').length,
  dropOffsetsSec: after.map((d) => `${d.who}${d.index}:${d.code}@${Math.round((d.t - t0) / 1000)}s`).slice(0, 50),
  adoption: [...adoptedAt.entries()].map(([i, s]) => `${i < nPhones ? 'spliced' : 'idle'}${i}@${Math.round(s)}s`),
  notAdopted: sample.filter((h) => !adoptedAt.has(h.index)).map((h) => h.index),
  ...load.summary()
}
await load.stop()
emit({ kind: 'deploy_report', ...report })
process.exit(0)
