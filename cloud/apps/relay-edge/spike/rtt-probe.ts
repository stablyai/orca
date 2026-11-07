// R9: latency from where this runs (e.g. an HK VM) through the edge. Measures phone open ->
// relay-hello and phone -> host -> phone echo round trips. The local host runs next to the phone,
// so echo RTT ~= 2 x (client <-> edge) plus splice cost; compare with today's cell from the same VM.
//   tsx spike/rtt-probe.ts --url <origin> [--opens 20] [--echoes 50] [--size 1024]
import { edgeInfo, loadOrCreateKeys, parseArgs, pct, sleep, startHost, startPhone } from './lib'

const a = parseArgs({ url: 'http://127.0.0.1:8787', opens: '20', echoes: '50', size: '1024', 'run-tag': 'rtt' })
const url = a.url.replace(/\/$/, '')
const keys = await loadOrCreateKeys()
const info = await edgeInfo(url)
const host = await startHost({ url, keys, index: 0, runTag: a['run-tag'], reconnect: false, onEvent: () => {} })

const helloMs: number[] = []
let fails = 0
for (let i = 0; i < Number(a.opens); i++) {
  await new Promise<void>((resolve) => {
    const p = startPhone({
      url,
      relayHostId: host.relayHostId,
      token: keys.phoneToken,
      framesPerSec: 0,
      mix: [{ size: 64, w: 1 }],
      binaryShare: 0,
      onHello: (ok, ms) => {
        if (ok) helloMs.push(ms)
        else fails++
        clearTimeout(timer)
        p.close()
        resolve()
      },
      onClose: () => {
        clearTimeout(timer)
        resolve()
      }
    })
    // Never wait on a close handshake; count a missing hello as a failure.
    const timer = setTimeout(() => {
      fails++
      p.ws.terminate()
      resolve()
    }, 10_000)
  })
  await sleep(200)
}

const rtts: number[] = await new Promise((resolve) => {
  const out: number[] = []
  const p = startPhone({
    url,
    relayHostId: host.relayHostId,
    token: keys.phoneToken,
    framesPerSec: 0,
    mix: [{ size: Number(a.size), w: 1 }],
    binaryShare: 0,
    onHello: async (ok, _ms, raw) => {
      if (!ok) {
        console.error(`echo phone refused: ${JSON.stringify(raw)}`)
        p.close()
        return
      }
      for (let i = 0; i < Number(a.echoes); i++) {
        const before = p.stats.received
        const body = Buffer.alloc(Number(a.size), 0x61)
        body.write(String(Date.now()).padStart(13, '0'), 0)
        p.ws.send(body.toString())
        const deadline = Date.now() + 10_000
        while (p.stats.received === before && Date.now() < deadline) await sleep(1)
        if (p.stats.received === before) break
        out.push(p.stats.rtts.at(-1)!)
      }
      p.close()
      resolve(out)
    },
    onClose: () => resolve(out)
  })
})
await host.stop()
console.log(
  JSON.stringify({
    colo: info?.colo ?? 'unknown',
    version: info?.version ?? null,
    opens: helloMs.length,
    openFails: fails,
    openToHelloMs: { p50: pct(helloMs, 0.5), p95: pct(helloMs, 0.95), max: Math.max(...helloMs) },
    echoRttMs: { p50: pct(rtts, 0.5), p95: pct(rtts, 0.95), max: Math.max(...rtts), n: rtts.length, size: Number(a.size) }
  })
)
process.exit(0)
