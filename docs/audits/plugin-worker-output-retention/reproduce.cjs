const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { once, EventEmitter } = require('node:events')
const { load, loadSources, sha, read } = require('./sources.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const suffix = 'retained-output-tail'

async function heap() {
  ;/reset/.test('reset')
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    global.gc()
  }
  return process.memoryUsage().heapUsed
}

function emitChunk(stream, chars, index, complete, truncated = false) {
  if (truncated) {
    stream.write(`${index.toString().padStart(4, '0')}${'x'.repeat(chars - 5)}\n`)
    return
  }
  const label = `${index.toString().padStart(4, '0')}:${suffix}`
  const final = `\n${label}${complete ? '\n' : ''}`
  const text = `${' '.repeat(chars - final.length)}${final}`
  stream.write(text)
}

async function tail(api, variant, chars, count) {
  const streams = []
  const start = await heap()
  for (let i = 0; i < count; i++) {
    const stream = new PassThrough()
    api.pipePluginWorkerOutput(stream, 'info', () => {})
    emitChunk(stream, chars, i, false)
    streams.push(stream)
  }
  const heldDelta = (await heap()) - start
  const retains = variant === 'before'
  assert.ok(
    retains ? heldDelta > chars * count * 0.75 : heldDelta < 768 * 1024,
    JSON.stringify({ variant, kind: 'tail', chars, count, heldDelta })
  )
  for (const stream of streams) {
    const ended = once(stream, 'end')
    stream.end()
    await ended
  }
  const endedDelta = (await heap()) - start
  assert.ok(endedDelta < 768 * 1024, JSON.stringify({ variant, endedDelta }))
  return { kind: 'tail', variant, chars, count, heldDelta, endedDelta }
}

function verifyRing(log, count, truncated) {
  assert.equal(log.get('plugin').length, Math.min(count, 200))
  for (const [index, row] of log.get('plugin').entries()) {
    const inputIndex = index + Math.max(0, count - 200)
    assert.equal(row.level, 'info')
    assert.equal(
      row.line,
      truncated
        ? `${inputIndex.toString().padStart(4, '0')}${'x'.repeat(8192 - 4 - '… [truncated]'.length)}… [truncated]`
        : `${inputIndex.toString().padStart(4, '0')}:${suffix}`
    )
  }
}

async function ring(api, variant, chars, count, truncated = false) {
  const log = new api.PluginLogBuffer()
  const stream = new PassThrough()
  api.pipePluginWorkerOutput(stream, 'info', (level, line) => log.append('plugin', level, line))
  const start = await heap()
  for (let i = 0; i < count; i++) {
    emitChunk(stream, chars, i, true, truncated)
  }
  assert.equal(log.get('plugin').length, Math.min(count, 200))
  const heldDelta = (await heap()) - start
  const retains = variant === 'before' || variant === 'tail-only'
  const expectedParents = Math.min(count, 200)
  const fixedBudget = expectedParents * (truncated ? 20 * 1024 : 0) + 768 * 1024
  assert.ok(
    retains ? heldDelta > chars * expectedParents * 0.75 : heldDelta < fixedBudget,
    JSON.stringify({ variant, kind: 'ring', chars, count, truncated, heldDelta })
  )
  const ended = once(stream, 'end')
  stream.end()
  await ended
  const endedDelta = (await heap()) - start
  assert.ok(retains ? endedDelta > chars * expectedParents * 0.75 : endedDelta < fixedBudget)
  for (let i = 0; i < 200; i++) {
    log.append('plugin', 'info', 'replacement')
  }
  const evictedDelta = (await heap()) - start
  assert.ok(evictedDelta < 768 * 1024, JSON.stringify({ variant, evictedDelta }))
  assert.equal(log.get('plugin').length, 200)
  return {
    kind: 'ring',
    variant,
    chars,
    count,
    truncated,
    expectedParents,
    heldDelta,
    endedDelta,
    evictedDelta
  }
}

async function behavior(api) {
  const lines = []
  const stream = new PassThrough()
  api.pipePluginWorkerOutput(stream, 'error', (level, line) => lines.push([level, line]))
  for (const chunk of ['  \nhello', ' world\n', 'x'.repeat(8193), 'discarded', '\nok\n', suffix]) {
    stream.write(chunk)
  }
  const ended = once(stream, 'end')
  stream.end()
  await ended
  assert.equal(lines.length, 4)
  assert.deepEqual(lines[0], ['error', 'hello world'])
  assert.equal(lines[1][1].length, 8192)
  assert.ok(lines[1][1].endsWith('… [truncated]'))
  assert.deepEqual(lines[2], ['error', 'ok'])
  assert.deepEqual(lines[3], ['error', suffix])
  const unicode = []
  const direct = new EventEmitter()
  direct.setEncoding = (encoding) => assert.equal(encoding, 'utf8')
  api.pipePluginWorkerOutput(null, 'info', () => assert.fail('Null stream emitted'))
  api.pipePluginWorkerOutput(direct, 'info', (level, line) => unicode.push([level, line]))
  for (const chunk of [
    '',
    ' \r\n',
    'short\n',
    'twelve chars\n',
    '\ud800a\udfff\u0000\u6f22\n',
    '😀'.repeat(4096),
    '\n',
    `${'a'.repeat(8191)}\ud800`,
    '\udfff\n',
    'q'.repeat(8193),
    'still discarding',
    '\nnext\r\n',
    'unterminated 😀'
  ]) {
    direct.emit('data', chunk)
  }
  direct.emit('end')
  assert.equal(unicode.length, 8)
  assert.deepEqual(unicode[2], ['info', '\ud800a\udfff\u0000\u6f22'])
  assert.deepEqual(unicode[3], ['info', '😀'.repeat(4096)])
  assert.equal(unicode[4][1].length, 8192)
  assert.ok(unicode[4][1].endsWith('… [truncated]'))
  assert.deepEqual(unicode[6], ['info', 'next\r'])
  assert.deepEqual(unicode[7], ['info', 'unterminated 😀'])
  // Keep value comparisons outside heap controls: they can flatten cons strings.
  for (const truncated of [false, true]) {
    const log = new api.PluginLogBuffer()
    const ringStream = new PassThrough()
    api.pipePluginWorkerOutput(ringStream, 'info', (level, line) =>
      log.append('plugin', level, line)
    )
    for (let i = 0; i < 3; i++) {
      emitChunk(ringStream, 16 * 1024, i, true, truncated)
    }
    verifyRing(log, 3, truncated)
    const ringEnded = once(ringStream, 'end')
    ringStream.end()
    await ringEnded
  }
  return { lines, unicode }
}

async function main() {
  const reports = [],
    bundles = {},
    behaviors = {}
  for (const variant of ['before', 'tail-only', 'fixed-buffer', 'fixed-fallback']) {
    const api = await load(variant)
    bundles[variant] = api.provenance
    if (variant !== 'before') {
      api.resetOwnRetainedStringCopier()
      const originalBuffer = globalThis.Buffer
      try {
        if (variant === 'fixed-fallback') {
          globalThis.Buffer = undefined
        }
        assert.equal(api.ownRetainedString(suffix), suffix)
      } finally {
        globalThis.Buffer = originalBuffer
      }
    }
    behaviors[variant] = await behavior(api)
    reports.push(await tail(api, variant, 64 * 1024, 10))
    reports.push(await tail(api, variant, 4 * 1024 * 1024, 8))
    reports.push(await ring(api, variant, 64 * 1024, 205))
    reports.push(await ring(api, variant, 4 * 1024 * 1024, 8))
    reports.push(await ring(api, variant, 64 * 1024, 205, true))
    reports.push(await ring(api, variant, 4 * 1024 * 1024, 8, true))
  }
  assert.deepEqual(behaviors.before, behaviors['tail-only'])
  assert.deepEqual(behaviors.before, behaviors['fixed-buffer'])
  assert.deepEqual(behaviors.before, behaviors['fixed-fallback'])
  const normalSources = loadSources()
  let crlfReads = 0
  const crlfSources = loadSources((file) => {
    crlfReads += 1
    return read(file).replaceAll('\n', '\r\n')
  })
  assert.deepEqual(crlfSources, normalSources)
  const args = process.argv.slice(2)
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output'))
  const output =
    args.length === 2
      ? path.resolve(args[1])
      : path.join(__dirname, `${process.versions.electron ? 'electron' : 'node'}-results.json`)
  const artifactHashes = Object.fromEntries(
    ['reproduce.cjs', 'sources.cjs', 'source-versions.json', 'fix.patch'].map((file) => [
      file,
      sha(read(path.join(__dirname, file)))
    ])
  )
  fs.writeFileSync(
    output,
    `${JSON.stringify(
      {
        runtime: process.versions,
        artifactHashes,
        crlfLoaderControl: { reads: crlfReads, identical: true },
        bundles,
        behaviors,
        reports
      },
      null,
      2
    )}\n`
  )
  console.log(JSON.stringify({ output, passed: reports.length }))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
setTimeout(() => {
  console.error('deadline')
  process.exit(2)
}, 30000).unref()
