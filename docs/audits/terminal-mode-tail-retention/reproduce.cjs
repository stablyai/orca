const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadSource, sha, read } = require('./load-source.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc')
const pending = '\x1b[?1049;2004;1000;'
const sizes = [
  [64 * 1024, 32],
  [4 * 1024 * 1024, 8]
]

async function heap() {
  // Isolate owner storage from V8's process-wide last successful regexp input.
  ;/reset/.test('reset')
  for (let round = 0; round < 4; round++) {
    await new Promise((resolve) => setImmediate(resolve))
    global.gc()
  }
  return process.memoryUsage().heapUsed
}

function createOwner(Owner, method, chars, index, suffix) {
  const prefix = `${index}:`
  const data = `${prefix}${'x'.repeat(chars - prefix.length - suffix.length)}${suffix}`
  const owner = new Owner()
  owner[method](data)
  return owner
}

async function measure(Owner, variant, kind, method, inputChars, count, suffix = pending) {
  const beforeHeap = await heap()
  const owners = Array.from({ length: count }, (_, index) =>
    createOwner(Owner, method, inputChars, index, suffix)
  )
  const heapDelta = (await heap()) - beforeHeap
  const expectedTailLength = suffix.length > 4096 || suffix.endsWith('h') ? 0 : suffix.length
  assert.ok(owners.every((owner) => owner.scanTail.length === expectedTailLength))
  const retainsParent = variant === 'baseline' && expectedTailLength >= 13
  assert.ok(
    retainsParent ? heapDelta > inputChars * count * 0.75 : heapDelta < 768 * 1024,
    JSON.stringify({ variant, kind, method, inputChars, count, expectedTailLength, heapDelta })
  )

  for (const owner of owners) {
    owner[method]('1006h')
    if (kind === 'kitty') {
      if (suffix === pending) {
        assert.equal(owner.isAlternateScreen, true)
      }
      owner[method]('\x1b[>3u')
      assert.equal(owner.flags, 3)
      owner.scan('\x1b[<u')
      assert.equal(owner.flags, 0)
    } else if (expectedTailLength >= 13) {
      assert.equal(owner.mouseTrackingMode, 'vt200')
      assert.equal(owner.sgrMouseMode, true)
    }
    assert.equal(owner.scanTail, '')
  }
  const afterCompletionDelta = (await heap()) - beforeHeap
  assert.ok(
    afterCompletionDelta < 768 * 1024,
    JSON.stringify({ variant, kind, method, afterCompletionDelta })
  )
  for (const owner of owners) {
    if (kind === 'kitty') {
      owner.resetForSnapshot()
      assert.equal(owner.snapshotFlags, undefined)
    } else {
      owner.scan('\x1bc')
      assert.equal(owner.mouseTrackingMode, 'none')
      assert.equal(owner.sgrMouseMode, false)
    }
  }
  return {
    variant,
    kind,
    method,
    inputChars,
    count,
    expectedTailLength,
    heapDelta,
    afterCompletionDelta
  }
}

function configureCopier(api, fallback) {
  api.resetOwnRetainedStringCopier()
  const originalBuffer = globalThis.Buffer
  try {
    if (fallback) {
      globalThis.Buffer = undefined
    }
    assert.equal(api.ownRetainedString(pending), pending)
  } finally {
    globalThis.Buffer = originalBuffer
  }
}

function behavior(Tracker, Mirror) {
  const replay = new Tracker()
  for (let index = 0; index < 70; index++) {
    replay.scanReplay('\x1b[>3u')
  }
  assert.equal(replay.mainStack.length, 0)
  assert.equal(replay.flags, 3)
  replay.scan('\x1b[<u')
  assert.equal(replay.flags, 0)
  const live = new Tracker()
  for (let index = 0; index < 70; index++) {
    live.scan('\x1b[>3u')
  }
  assert.equal(live.mainStack.length, 16)
  live.scan('\x1b[?1049h\x1b[>5u')
  assert.equal(live.altStack.length, 1)
  live.scan('\x1b[?1049l')
  assert.equal(live.flags, 3)
  live.scan(`\x1bc${pending}`)
  assert.equal(live.flags, 0)
  assert.equal(live.scanTail, pending)
  live.scan('1006h')
  assert.equal(live.isAlternateScreen, true)
  live.reset()
  assert.equal(live.scanTail, '')
  assert.equal(live.snapshotFlags, 0)

  const mouse = new Mirror()
  mouse.scan('\x1b[?1003;1016h')
  assert.equal(mouse.mouseTrackingMode, 'any')
  assert.equal(mouse.sgrMousePixelsMode, true)
  mouse.scan('\x9b?1002;1006h')
  assert.equal(mouse.mouseTrackingMode, 'drag')
  assert.equal(mouse.sgrMouseMode, true)
  assert.equal(mouse.sgrMousePixelsMode, false)
  mouse.scan(`\x1bc${pending}`)
  assert.equal(mouse.mouseTrackingMode, 'none')
  assert.equal(mouse.scanTail, pending)
  mouse.scan('1006h')
  assert.equal(mouse.mouseTrackingMode, 'vt200')
  assert.equal(mouse.sgrMouseMode, true)
}

async function main() {
  const reports = []
  const bundles = {}
  for (const variant of ['baseline', 'fixed-buffer', 'fixed-fallback']) {
    const api = await loadSource(variant !== 'baseline')
    const { TerminalKittyKeyboardModeTracker: Tracker, TerminalMouseModeMirror: Mirror } = api
    bundles[variant] = {
      bundleSha256: api.bundleSha256,
      evaluatedSources: api.evaluatedSources,
      sourceVersionsSha256: api.sourceVersionsSha256
    }
    configureCopier(api, variant === 'fixed-fallback')
    behavior(Tracker, Mirror)
    for (const [kind, Owner, methods] of [
      ['kitty', Tracker, ['scan', 'scanReplay']],
      ['mouse', Mirror, ['scan']]
    ]) {
      for (const method of methods) {
        for (const [chars, count] of sizes) {
          reports.push(await measure(Owner, variant, kind, method, chars, count))
        }
      }
      for (const suffix of [
        '\x1b[',
        '\x1b[?1049;2004;1000;1006h',
        `\x1b[${'1'.repeat(4095)}`,
        pending.replace('\x1b[', '\x9b')
      ]) {
        reports.push(await measure(Owner, variant, kind, 'scan', 4 * 1024 * 1024, 8, suffix))
      }
    }
  }
  const report = {
    node: process.version,
    electron: process.versions.electron ?? null,
    v8: process.versions.v8,
    platform: process.platform,
    runnerSha256: sha(read(__filename)),
    loaderSha256: sha(read(path.join(__dirname, 'load-source.cjs'))),
    pendingTailCodeUnits: pending.length,
    clearedRegexStatics: true,
    bundles,
    reports
  }
  const output = path.join(
    __dirname,
    `${process.versions.electron ? 'electron' : 'node'}-results.json`
  )
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify({ output, passed: reports.length, node: report.node, electron: report.electron })
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
setTimeout(() => {
  console.error('fixture deadline')
  process.exit(2)
}, 30000).unref()
