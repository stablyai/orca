import { afterEach, beforeEach, expect, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { SshChannelMultiplexer } from '../../../src/main/ssh/ssh-channel-multiplexer'
import { readFileViaStream } from '../../../src/main/ssh/ssh-filesystem-stream-reader'
import { RelayDispatcher } from '../../../src/relay/dispatcher'
import { RelayStreamRegistry } from '../../../src/relay/fs-stream-registry'
import { readRelayFileStreamMetadata } from '../../../src/relay/fs-handler-file-read'

import { createRequire } from 'node:module'
const { loadSources } = createRequire(import.meta.url)('./sources.cjs')
const sourceInfo = loadSources()
const gates = new Map()
const candidate = process.env.ORCA_SSH_READER_VARIANT !== 'before'
const graph = process.env.ORCA_SSH_READER_GRAPH ?? 'worktree'
const artifactNames = [
  'sources.cjs',
  'relay-fixture.mjs',
  'scenario.test.mjs',
  'vitest.config.mjs',
  'before.config.mjs',
  'fix.patch',
  'main-context.patch',
  'source-versions.json'
]
const report = {
  variant: candidate ? 'fixed' : 'before',
  graph,
  runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
  sources: sourceInfo.hashes,
  observedReaderSha256: sourceInfo.observedReaderSha256,
  controls: []
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
let directory
let fixtures
let heldPaths
function gate(path) {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  gates.set(path, { promise, release })
}
async function heldFiles(count) {
  const paths = []
  for (let i = 0; i < count; i++) {
    const path = join(directory, `held-${i}.png`)
    await writeFile(path, '')
    gate(path)
    paths.push(path)
    heldPaths.push(path)
  }
  return paths
}
function connect({ pacing = true, passAcks = true, blockFirstWrite = false } = {}) {
  let receive
  let drain
  let blocked = blockFirstWrite
  const registry = new RelayStreamRegistry()
  const stats = { peakStreams: 0, chunks: 0, ends: 0, acks: 0, contexts: [], wireOrder: [] }
  const dispatcher = new RelayDispatcher(
    (data) => {
      if (data[0] === 1) {
        const message = JSON.parse(data.subarray(13).toString())
        stats.wireOrder.push(message.method ?? 'response')
      }
      receive(data)
      if (blocked) {
        blocked = false
        return false
      }
    },
    {
      waitWriteDrain(callback) {
        drain = callback
        return () => {}
      }
    }
  )
  const mux = new SshChannelMultiplexer({
    write(data) {
      dispatcher.feed(data)
    },
    onData(callback) {
      receive = callback
    },
    onClose() {}
  })
  dispatcher.onRequest('fs.readFileStream', async (params, context) => {
    stats.contexts.push(context)
    await gates.get(params.filePath)?.promise
    const result = await readRelayFileStreamMetadata(
      params.filePath,
      dispatcher,
      registry,
      context,
      { clientId: context.clientId, paceWithAcks: pacing && params.flowControl === 'ack' }
    )
    stats.peakStreams = Math.max(stats.peakStreams, registry.size())
    return result
  })
  dispatcher.onNotification('fs.streamAck', (params) => {
    stats.acks++
    if (passAcks) {
      registry.recordAck(params.streamId, params.seq)
    }
  })
  dispatcher.onNotification('fs.cancelStream', (params) => registry.abort(params.streamId))
  mux.onNotificationByMethod('fs.streamChunk', () => {
    stats.chunks++
  })
  mux.onNotificationByMethod('fs.streamEnd', () => {
    stats.ends++
  })
  const fixture = {
    mux,
    dispatcher,
    registry,
    stats,
    drain() {
      drain?.()
    }
  }
  fixtures.push(fixture)
  return fixture
}
function snapshot(paths) {
  const rows = paths.map((path) => globalThis.__sshPendingReaders.get(path)?.deref() ?? [])
  const unique = new Set(rows.flatMap((row) => row.map((frame) => frame.params)))
  const bytes = [...unique].reduce(
    (sum, params) => sum + (typeof params.data === 'string' ? params.data.length : 0),
    0
  )
  return {
    readers: paths.length,
    entries: rows.map((row) => row.length),
    wrappers: rows.reduce((sum, row) => sum + row.length, 0),
    uniqueParams: unique.size,
    logicalBase64BytesByUniqueParams: bytes,
    sharedAcrossReaders:
      rows.length > 1 &&
      rows[0].length > 0 &&
      rows.every((row) => row.every((frame, index) => frame.params === rows[0][index]?.params))
  }
}
async function collect() {
  for (let i = 0; i < 5; i++) {
    await nextTurn()
    global.gc()
  }
  await nextTurn()
}
async function assertReleased(paths) {
  await collect()
  for (const path of paths) {
    expect(globalThis.__sshPendingReaders.get(path)?.deref()).toBeUndefined()
  }
}
async function makePayload(size) {
  const path = join(directory, 'payload.png')
  const bytes = randomBytes(size)
  await writeFile(path, bytes)
  return { path, hash: createHash('sha256').update(bytes).digest('hex'), size }
}
async function successfulRead(mux, payload) {
  const result = await readFileViaStream(mux, payload.path)
  expect(result.isImage).toBe(true)
  const bytes = Buffer.from(result.content, 'base64')
  expect(bytes.length).toBe(payload.size)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(payload.hash)
}
beforeEach(async () => {
  expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  directory = await mkdtemp(join(tmpdir(), 'orca-ssh-reader-'))
  fixtures = []
  heldPaths = []
  globalThis.__sshPendingReaders = new Map()
})
afterEach(async () => {
  vi.useRealTimers()
  for (const entry of gates.values()) {
    entry.release()
  }
  gates.clear()
  for (const fixture of fixtures) {
    fixture.mux.dispose()
    fixture.dispatcher.dispose()
    await fixture.registry.disposeAll()
  }
  await nextTurn()
  await rm(directory, { recursive: true, force: true })
  report.artifactHashes = Object.fromEntries(
    artifactNames.map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest('hex')
    ])
  )
  writeFileSync(
    process.env.ORCA_SSH_READER_OUTPUT ??
      new URL(
        `./${graph}-${report.variant}-${process.versions.electron ? 'electron' : 'node'}-results.json`,
        import.meta.url
      ),
    `${JSON.stringify(report, null, 2)}\n`
  )
})

export {
  candidate,
  report,
  nextTurn,
  gates,
  heldFiles,
  connect,
  snapshot,
  collect,
  assertReleased,
  makePayload,
  successfulRead
}
