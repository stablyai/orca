import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Run from the worktree root: node config/scripts/benchmark-cli-response-framing.mjs <base-ref>
const sourcePath = 'src/cli/runtime/transport.ts'
const baselineRef = process.argv[2]
assert.ok(baselineRef, 'Pass the pre-change transport revision as base-ref.')
const beforeSource = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], {
  encoding: 'utf8'
})
let chunks = []

async function loadTransport(source) {
  const built = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: dirname(resolve(sourcePath)) },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  })
  const module = new Module(resolve(sourcePath))
  const originalRequire = module.require.bind(module)
  module.require = (name) => {
    if (name === 'node:crypto') {
      return { randomUUID: () => 'benchmark-request' }
    }
    if (name !== 'node:net') {
      return originalRequire(name)
    }
    return {
      createConnection() {
        const socket = new EventEmitter()
        socket.setEncoding = () => {}
        socket.end = () => {}
        socket.destroy = () => {}
        socket.write = () => {
          for (const chunk of chunks) {
            socket.emit('data', chunk)
          }
        }
        queueMicrotask(() => socket.emit('connect'))
        return socket
      }
    }
  }
  module._compile(built.outputFiles[0].text, resolve(sourcePath))
  return module.exports.sendRequest
}

const before = await loadTransport(beforeSource)
const after = await loadTransport(readFileSync(sourcePath, 'utf8'))
const metadata = {
  runtimeId: 'benchmark-runtime',
  authToken: 'benchmark-token',
  transports: [{ kind: 'unix', endpoint: 'injected-socket' }]
}
const run = (sendRequest) => sendRequest(metadata, 'terminal.read', {}, 30000)

async function measure(sendRequest, payloadBytes, repetitions) {
  const warmup = await run(sendRequest)
  assert.equal(warmup.result.data.length, payloadBytes)
  const samples = []
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now()
    for (let iteration = 0; iteration < repetitions; iteration++) {
      await run(sendRequest)
    }
    samples.push((performance.now() - start) / repetitions)
  }
  return samples.sort((a, b) => a - b)[2]
}

async function searchedCharacters(sendRequest) {
  const original = String.prototype.indexOf
  let searched = 0
  String.prototype.indexOf = function (needle, position) {
    if (needle === '\n') {
      searched += this.length - (position ?? 0)
    }
    return original.call(this, needle, position)
  }
  try {
    await run(sendRequest)
  } finally {
    String.prototype.indexOf = original
  }
  return searched
}

const rows = []
for (const [payloadBytes, chunkChars, repetitions] of [
  [32, 65536, 1000],
  [1024 * 1024, 2 * 1024 * 1024, 20],
  [1024 * 1024, 65536, 10],
  [1024 * 1024, 4096, 5],
  [4 * 1024 * 1024, 4096, 2],
  [4 * 1024 * 1024, 256, 1]
]) {
  const line = `${JSON.stringify({
    id: 'benchmark-request',
    ok: true,
    result: { data: 'x'.repeat(payloadBytes) },
    _meta: { runtimeId: 'benchmark-runtime' }
  })}\n`
  chunks = []
  for (let offset = 0; offset < line.length; offset += chunkChars) {
    chunks.push(line.slice(offset, offset + chunkChars))
  }
  const beforeMs = await measure(before, payloadBytes, repetitions)
  const afterMs = await measure(after, payloadBytes, repetitions)
  rows.push({
    payloadBytes,
    chunkChars,
    beforeMs: +beforeMs.toFixed(6),
    afterMs: +afterMs.toFixed(6),
    speedup: +(beforeMs / afterMs).toFixed(2),
    beforeSearchedCharacters: await searchedCharacters(before),
    afterSearchedCharacters: await searchedCharacters(after)
  })
}
console.log(JSON.stringify({ node: process.version, baselineRef, rows }, null, 2))
