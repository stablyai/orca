import { once } from 'node:events'
import { createServer, Socket } from 'node:net'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const built = await build({
  entryPoints: [resolve(root, 'src/main/daemon/daemon-stream-data-batcher.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const bundle = built.outputFiles[0].text
const { DaemonStreamDataBatcher } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`
)
const MiB = 1024 * 1024

async function run(chunkSize, hidden) {
  const server = createServer()
  const writer = new Socket()
  let reader
  let paused = false
  let produced = 0
  let receivedBytes = 0
  const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: writer }), {
    onProducerBackpressureChanged: (_sessionId, value) => {
      paused = value
    },
    isSessionDroppable: () => hidden
  })
  writer.on('drain', () => batcher.flush('client'))
  try {
    const accepted = once(server, 'connection')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address')
    }
    writer.connect(address.port, '127.0.0.1')
    await once(writer, 'connect')
    ;[reader] = await accepted
    reader.on('data', (data) => {
      receivedBytes += data.length
    })
    reader.pause()
    const chunk = 'x'.repeat(chunkSize)
    while (!paused && produced < 8 * MiB) {
      batcher.enqueue('client', 'session', chunk, { flushImmediately: true, flushMaxChars: 1024 })
      batcher.flush('client')
      produced += chunkSize
      if (produced % MiB === 0) {
        await nextTurn()
      }
    }
    const stalled = {
      producedChars: produced,
      producerPaused: paused,
      socketBufferedBytes: writer.writableLength,
      batcherQueuedChars: batcher.queuedCharsForClient('client'),
      rssBytes: process.memoryUsage().rss
    }
    reader.resume()
    const start = performance.now()
    while (paused || writer.writableLength || batcher.queuedCharsForClient('client')) {
      if (performance.now() - start > 5000) {
        throw new Error('Failed to drain')
      }
      await delay(5)
    }
    const ended = once(reader, 'end')
    writer.end()
    await ended
    return {
      chunkSize,
      hidden,
      stalled,
      receivedBytes,
      afterDrain: {
        producerPaused: paused,
        socketBufferedBytes: writer.writableLength,
        batcherQueuedChars: batcher.queuedCharsForClient('client')
      }
    }
  } finally {
    batcher.clear()
    writer.destroy()
    reader?.destroy()
    await new Promise((done) => server.close(done))
  }
}

const cases = [await run(64 * 1024, false), await run(1024, false), await run(1024, true)]
if (!cases[0].stalled.producerPaused || !cases[1].stalled.producerPaused) {
  throw new Error('Visible producer did not pause under the stalled-reader budget')
}
if (cases[2].stalled.producerPaused || cases[2].stalled.producedChars !== 8 * MiB) {
  throw new Error('Droppable producer paused or failed to process the full reproduction input')
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      cases
    },
    null,
    2
  )
)
