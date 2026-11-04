// R4 on Cloudflare: a phone that stops reading while its host keeps sending.
// The slow phone sends N large frames; the echo host sends them back into a phone whose TCP reads
// are paused, so the splice object must buffer them. A healthy phone on the same host and the host
// control are watched throughout. Reports whether the splice object is reset and what others see.
//   tsx spike/flood-cf.ts --url <origin> [--frames 200] [--size 921600]
import { emit, loadOrCreateKeys, parseArgs, setEventFile, sleep, startHost, startPhone } from './lib'

const a = parseArgs({ url: 'http://127.0.0.1:8787', frames: '200', size: '921600', out: '' })
setEventFile(a.out || null)
const keys = await loadOrCreateKeys()
const runTag = `flood-${Date.now()}`
const host = await startHost({ url: a.url, keys, index: 0, runTag, reconnect: false, onEvent: (e) => emit(e) })

const open = (label: string, fps: number) =>
  new Promise<ReturnType<typeof startPhone> & { closed: { code: number; at: number } | null }>((resolve) => {
    const p = Object.assign(
      startPhone({
        url: a.url,
        relayHostId: host.relayHostId,
        token: keys.phoneToken,
        framesPerSec: fps,
        mix: [{ size: 256, w: 1 }],
        binaryShare: 0,
        onHello: (ok) => {
          emit({ kind: 'phone_hello', label, ok })
          resolve(p)
        },
        onClose: (code) => {
          p.closed = { code, at: Date.now() }
          emit({ kind: 'phone_close', label, code })
        }
      }),
      { closed: null as { code: number; at: number } | null }
    )
  })

const healthy = await open('healthy', 2)
const slow = await open('slow', 0)
const tcp = (slow.ws as unknown as { _socket: import('node:net').Socket })._socket
tcp.pause()
const t0 = Date.now()
const frame = Buffer.alloc(Number(a.size), 0x62)
let sent = 0
for (; sent < Number(a.frames); sent++) {
  if (slow.ws.readyState !== slow.ws.OPEN) break
  await new Promise<void>((r) => slow.ws.send(frame, { binary: true }, () => r()))
}
emit({ kind: 'flood_sent', frames: sent, mib: Math.round((sent * frame.length) / 1048576), seconds: (Date.now() - t0) / 1000 })
const receivedBefore = healthy.stats.received
await sleep(60_000)
tcp.resume()
await sleep(10_000)
emit({
  kind: 'flood_report',
  framesSent: sent,
  slowClosed: slow.closed?.code ?? null,
  slowClosedAfterSec: slow.closed ? (slow.closed.at - t0) / 1000 : null,
  slowReceivedFrames: slow.stats.received,
  healthyClosed: healthy.closed?.code ?? null,
  healthyEchoesDuringWatch: healthy.stats.received - receivedBefore,
  hostLive: host.live()
})
healthy.close()
slow.close()
await host.stop()
process.exit(0)
