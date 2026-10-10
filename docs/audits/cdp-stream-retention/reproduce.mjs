import { once } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const built = await build({
  entryPoints: [resolve(root, 'src/main/browser/cdp-client-response-writer.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});`
  }
})
const bundle = built.outputFiles[0].text
const { CdpClientResponseWriter } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`
)
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Background policy required')
}
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await once(wss, 'listening')
const accepted = once(wss, 'connection')
const address = wss.address()
if (!address || typeof address === 'string') {
  throw new Error('Expected TCP address')
}
const peer = new WebSocket(`ws://127.0.0.1:${address.port}`)
await once(peer, 'open')
const [socket] = await accepted
const writer = new CdpClientResponseWriter(() => socket)
peer.pause()
const samples = []
try {
  for (let index = 1; index <= 128; index++) {
    writer.send({ method: 'Network.dataReceived', params: { data: 'x'.repeat(1024 * 1024) } })
    if (index % 16 === 0) {
      await nextTurn()
      samples.push({
        producedMiB: index,
        bufferedBytes: socket.bufferedAmount,
        readyState: socket.readyState,
        rss: process.memoryUsage().rss
      })
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        samples
      },
      null,
      2
    )
  )
} finally {
  writer.forgetClient(socket)
  socket.terminate()
  peer.terminate()
  await new Promise((done) => wss.close(done))
}
