import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

if (!global.gc) {
  throw new Error('Run with node --expose-gc')
}
const root = resolve(import.meta.dirname, '../..')
const directory = await mkdtemp(join(tmpdir(), 'orca-sentinel-retention-'))
const output = join(directory, 'sentinel.cjs')
try {
  await build({
    stdin: {
      contents: `export {waitForSentinel} from './src/main/ssh/ssh-relay-deploy-helpers';
export {RELAY_SENTINEL} from './src/main/ssh/relay-protocol';`,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    banner: {
      js: `var require = require('node:module').createRequire(${JSON.stringify(join(root, 'package.json'))});`
    },
    outfile: output
  })
  const { waitForSentinel, RELAY_SENTINEL } = createRequire(import.meta.url)(output)
  const held = []
  const banners = []
  for (let i = 0; i < 100; i++) {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdin: { write: () => true },
      close: () => {}
    })
    const pending = waitForSentinel(channel)
    banners.push(feedBanner(channel))
    channel.emit('data', Buffer.from(RELAY_SENTINEL))
    const transport = await pending
    const received = []
    transport.onData((bytes) => received.push(bytes.toString()))
    channel.emit('data', Buffer.from('frame'))
    assert.deepEqual(received, ['frame'])
    held.push({ channel, transport })
  }
  await new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < 5; i++) {
    global.gc()
  }
  const retained = banners.filter((reference) => reference.deref() !== undefined).length
  console.log(
    JSON.stringify({
      connections: held.length,
      bannerBytes: 65536,
      retainedBannerBuffers: retained,
      retainedBannerBytes: retained * 65536
    })
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}

function feedBanner(channel) {
  const banner = Buffer.alloc(65536, 120)
  channel.emit('data', banner)
  return new WeakRef(banner.buffer)
}
