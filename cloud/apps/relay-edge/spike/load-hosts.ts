// R1/R2/R4/R12 load: N synthetic hosts (shipped desktop client: hello, proof, pongs, echo data
// transport) plus M phones splicing a frame-size mix through the first M hosts.
//   tsx spike/load-hosts.ts --url <origin> [--hosts 1000] [--phones 50] [--rate 50]
//     [--fps 2] [--mix 256:0.7,4096:0.25,65536:0.05] [--binary 0.5] [--duration 600]
//     [--run-tag a] [--out events.jsonl] [--no-reconnect]
import {
  emit,
  loadOrCreateKeys,
  parseArgs,
  parseMix,
  pct,
  setEventFile,
  sleep,
  startHost,
  startPhone,
  type HostEvent,
  type PhoneStats,
  type SyntheticHost
} from './lib'

export type LoadHandle = {
  hosts: SyntheticHost[]
  phones: { stats: PhoneStats; close: () => void }[]
  drops: { t: number; who: 'host' | 'phone'; index: number; code: number }[]
  ups: { t: number; index: number; ms: number; rebind: boolean; generation: number }[]
  stop: () => Promise<void>
  summary: () => Record<string, unknown>
}

export async function runLoad(a: Record<string, string>): Promise<LoadHandle> {
  const keys = await loadOrCreateKeys()
  const url = a.url.replace(/\/$/, '')
  const nHosts = Number(a.hosts)
  const nPhones = Math.min(Number(a.phones), nHosts)
  const rate = Number(a.rate)
  const quiet = a.verbose !== 'true'
  const drops: LoadHandle['drops'] = []
  const ups: LoadHandle['ups'] = []
  const fails: string[] = []
  const hosts: SyntheticHost[] = []
  const phones: LoadHandle['phones'] = []
  let phonesUp = 0
  let stopping = false
  const retired = { sent: 0, received: 0, rtts: [] as number[] }

  const onHost = (e: HostEvent): void => {
    if (e.kind === 'host_up') ups.push({ t: Date.now(), index: e.host, ms: e.ms, rebind: e.rebind, generation: e.generation })
    if (e.kind === 'host_drop') drops.push({ t: Date.now(), who: 'host', index: e.host, code: e.code })
    if (e.kind === 'host_connect_fail') fails.push(e.error)
    // Ups during the initial ramp are routine; log everything else.
    emit(e, quiet && e.kind === 'host_up' && !e.rebind && ups.length <= nHosts)
  }

  const ramp: Promise<void>[] = []
  for (let i = 0; i < nHosts; i++) {
    ramp.push(
      startHost({ url, keys, index: i, runTag: a['run-tag'], reconnect: a['no-reconnect'] !== 'true', onEvent: onHost }).then(
        (h) => void hosts.push(h)
      )
    )
    await sleep(1000 / rate)
  }
  await Promise.all(ramp)
  emit({ kind: 'ramp_done', hosts: hosts.length, live: hosts.filter((h) => h.live()).length })

  const mix = parseMix(a.mix)
  const byIndex = [...hosts].sort((x, y) => x.index - y.index)
  for (let i = 0; i < nPhones; i++) {
    const h = byIndex[i]
    const startPhoneFor = (index: number): void => {
      const p = startPhone({
        url,
        relayHostId: h.relayHostId,
        token: keys.phoneToken,
        framesPerSec: Number(a.fps),
        mix,
        binaryShare: Number(a.binary),
        onHello: (ok, ms, raw) => {
          if (ok) phonesUp++
          else emit({ kind: 'phone_hello_fail', phone: index, ms, raw })
        },
        onClose: (code, reason) => {
          drops.push({ t: Date.now(), who: 'phone', index, code })
          emit({ kind: 'phone_drop', phone: index, code, reason })
          // Phone-like: reconnect after a short jittered wait unless stopping.
          if (!stopping && a['no-reconnect'] !== 'true') setTimeout(() => startPhoneFor(index), 500 + Math.random() * 2000)
        }
      })
      const prev = phones[index]
      if (prev) {
        retired.sent += prev.stats.sent
        retired.received += prev.stats.received
        retired.rtts.push(...prev.stats.rtts)
      }
      phones[index] = p
    }
    startPhoneFor(i)
    await sleep(1000 / rate)
  }

  return {
    hosts,
    phones,
    drops,
    ups,
    stop: async () => {
      stopping = true
      for (const p of phones) p?.close()
      await Promise.all(hosts.map((h) => h.stop()))
    },
    summary: () => {
      const byCode: Record<string, number> = {}
      for (const d of drops) byCode[`${d.who}:${d.code}`] = (byCode[`${d.who}:${d.code}`] ?? 0) + 1
      const rtts = [...retired.rtts, ...phones.flatMap((p) => p?.stats.rtts ?? [])]
      const reconnectMs = ups.slice(nHosts).map((u) => u.ms)
      return {
        hostsLive: hosts.filter((h) => h.live()).length,
        hosts: nHosts,
        phonesHelloOk: phonesUp,
        drops: drops.length,
        dropsByCode: byCode,
        firstDrop: drops[0] ? new Date(drops[0].t).toISOString() : null,
        lastDrop: drops.at(-1) ? new Date(drops.at(-1)!.t).toISOString() : null,
        reconnects: reconnectMs.length,
        rebinds: ups.slice(nHosts).filter((u) => u.rebind).length,
        reconnectMsP50: pct(reconnectMs, 0.5),
        reconnectMsP95: pct(reconnectMs, 0.95),
        connectFails: fails.length,
        framesSent: retired.sent + phones.reduce((s, p) => s + (p?.stats.sent ?? 0), 0),
        framesEchoed: retired.received + phones.reduce((s, p) => s + (p?.stats.received ?? 0), 0),
        phonesNoEcho: phones.filter((p) => p && p.stats.sent > 0 && p.stats.received === 0).length,
        echoRttMsP50: pct(rtts, 0.5),
        echoRttMsP95: pct(rtts, 0.95)
      }
    }
  }
}

export const LOAD_DEFAULTS = {
  url: 'http://127.0.0.1:8787',
  hosts: '1000',
  phones: '50',
  rate: '50',
  fps: '2',
  mix: '256:0.7,4096:0.25,65536:0.05',
  binary: '0.5',
  duration: '600',
  'run-tag': 'a',
  out: ''
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(LOAD_DEFAULTS)
  setEventFile(a.out || null)
  const load = await runLoad(a)
  const end = Date.now() + Number(a.duration) * 1000
  let stop = false
  process.on('SIGINT', () => (stop = true))
  while (!stop && Date.now() < end) {
    await sleep(Math.min(60_000, end - Date.now()))
    emit({ kind: 'summary', ...load.summary() })
  }
  await load.stop()
  emit({ kind: 'final', ...load.summary() })
  process.exit(0)
}
