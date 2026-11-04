// R3: how often do Cloudflare runtime restarts (not our deploys) drop sockets? Holds a small set
// of hosts (half with an idle phone splice) for days and logs every disconnect with code, time,
// ingress colo and edge version. Run from a VM in each region (US, HK).
//   tsx spike/canary.ts --url <origin> [--hosts 100] [--phones 50] [--run-tag canary-us]
//     [--out canary-us.jsonl] [--report-every 3600]
// Rate = host drops / host-days, excluding windows around our own deploys (see deploy events).
import { edgeInfo, emit, loadOrCreateKeys, parseArgs, setEventFile, sleep, startHost, startPhone, type SyntheticHost } from './lib'

const a = parseArgs({ url: 'http://127.0.0.1:8787', hosts: '100', phones: '50', 'run-tag': 'canary', out: '', 'report-every': '3600' })
setEventFile(a.out || null)
const url = a.url.replace(/\/$/, '')
const keys = await loadOrCreateKeys()
const startedAt = Date.now()
let colo = (await edgeInfo(url))?.colo ?? 'unknown'
const counts = { hostDrops: 0, phoneDrops: 0, byCode: {} as Record<string, number> }
const note = async (who: string, index: number, code: number): Promise<void> => {
  const info = await edgeInfo(url)
  if (info) colo = info.colo
  counts.byCode[`${who}:${code}`] = (counts.byCode[`${who}:${code}`] ?? 0) + 1
  emit({ kind: `${who}_drop`, index, code, colo, version: info?.version ?? null })
}

const hosts: SyntheticHost[] = []
for (let i = 0; i < Number(a.hosts); i++) {
  hosts.push(
    await startHost({
      url,
      keys,
      index: i,
      runTag: a['run-tag'],
      reconnect: true,
      onEvent: (e) => {
        if (e.kind === 'host_drop') {
          counts.hostDrops++
          void note('host', e.host, e.code)
        } else if (e.kind === 'host_up' && hosts.length >= Number(a.hosts)) {
          emit({ kind: 'host_recovered', index: e.host, ms: e.ms, rebind: e.rebind })
        }
      }
    })
  )
  await sleep(100)
}
// Idle phone splices: no traffic, just held open (like a paired phone left connected).
const startIdlePhone = (i: number): void => {
  startPhone({
    url,
    relayHostId: hosts[i].relayHostId,
    token: keys.phoneToken,
    framesPerSec: 0,
    mix: [{ size: 64, w: 1 }],
    binaryShare: 0,
    onHello: () => {},
    onClose: (code) => {
      counts.phoneDrops++
      void note('phone', i, code)
      setTimeout(() => startIdlePhone(i), 2000 + Math.random() * 3000)
    }
  })
}
for (let i = 0; i < Math.min(Number(a.phones), hosts.length); i++) startIdlePhone(i)
emit({ kind: 'canary_up', hosts: hosts.length, phones: Math.min(Number(a.phones), hosts.length), colo })

const report = (): void => {
  const hostDays = (hosts.length * (Date.now() - startedAt)) / 86_400_000
  emit({
    kind: 'canary_report',
    hours: +((Date.now() - startedAt) / 3_600_000).toFixed(2),
    live: hosts.filter((h) => h.live()).length,
    hostDrops: counts.hostDrops,
    phoneDrops: counts.phoneDrops,
    dropsPerHostDay: +(counts.hostDrops / Math.max(hostDays, 1e-9)).toFixed(4),
    byCode: counts.byCode,
    colo
  })
}
const timer = setInterval(report, Number(a['report-every']) * 1000)
process.on('SIGINT', async () => {
  clearInterval(timer)
  report()
  await Promise.all(hosts.map((h) => h.stop()))
  process.exit(0)
})
