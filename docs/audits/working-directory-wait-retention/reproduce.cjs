const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { load, loadSources, canonicalLf } = require('./sources.cjs')
const {
  fixtureKey,
  lifetime,
  laneOwnership,
  ordering,
  observerOrdering,
  alreadyAborted,
  canceledNativeRejection
} = require('./scenario.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
process.env.ORCA_APP_VERSION = 'synthetic-cwd-validation-audit'
function checkCrlfLoader() {
  const baseline = loadSources()
  let syntheticCrlfReads = 0
  const crlf = loadSources({
    readText(file) {
      syntheticCrlfReads++
      return canonicalLf(readFileSync(file, 'utf8')).replace(/\n/g, '\r\n')
    }
  })
  assert.equal(syntheticCrlfReads, 2)
  assert.deepEqual(crlf.before, baseline.before)
  assert.deepEqual(crlf.after, baseline.after)
  assert.deepEqual(crlf.hashes, baseline.hashes)
  return { syntheticCrlfReads, identicalSourcesAndHashes: true }
}

async function main() {
  const timer = setTimeout(() => {
    process.stderr.write('deadline\n')
    process.exit(2)
  }, 20_000)
  const unhandled = []
  const recordUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', recordUnhandled)
  const crlfLoaderControl = checkCrlfLoader()
  const loaded = { before: await load(false, fixtureKey), after: await load(true, fixtureKey) }
  const reports = {}
  for (const [mode, validation] of Object.entries(loaded)) {
    reports[mode] = {
      fulfilled: await lifetime(validation, mode === 'after', false),
      rejected: await lifetime(validation, mode === 'after', true),
      laneOwnership: await laneOwnership(validation),
      alreadyAborted: await alreadyAborted(validation),
      lateNativeRejection: await canceledNativeRejection(validation)
    }
  }
  const matrix = []
  for (const reject of [false, true]) {
    for (const startedBefore of [false, true]) {
      for (const ticks of [0, 1, 2, 3, 4, 8]) {
        for (const abortFirst of [false, true]) {
          const args = [reject, startedBefore, ticks, abortFirst]
          const before = await ordering(loaded.before, ...args)
          const after = await ordering(loaded.after, ...args)
          assert.deepEqual(after, before)
          matrix.push({ reject, startedBefore, ticks, abortFirst, before, after })
        }
      }
    }
  }
  const observers = []
  for (const position of ['before', 'between', 'after']) {
    for (const reject of [false, true]) {
      const before = await observerOrdering(loaded.before, position, reject)
      const after = await observerOrdering(loaded.after, position, reject)
      assert.deepEqual(after, before)
      observers.push({ position, reject, before, after })
    }
  }
  await new Promise(setImmediate)
  assert.deepEqual(unhandled, [])
  process.off('unhandledRejection', recordUnhandled)
  clearTimeout(timer)
  delete globalThis[fixtureKey]
  const report = {
    runtime: process.versions,
    sourceHashLineEndings: 'canonical LF',
    crlfLoaderControl,
    unhandledRejections: unhandled.length,
    reports,
    matrix,
    observers,
    versions: Object.fromEntries(
      Object.entries(loaded).map(([mode, value]) => [mode, value.versions])
    ),
    scope:
      'Actual cwd validation and semaphore source. Native stat replaced by one bounded deferred fixture; no filesystem probe, WSL process or app. 32 canceled small signals per case. Native ownership retained until actual fixture settlement, including shared UNC lane. Small per-call reaction/empty-holder metadata still lives until native settlement. No synthetic large payload or incident RSS claim.'
  }
  writeFileSync(
    path.join(__dirname, process.versions.electron ? 'electron-results.json' : 'node-results.json'),
    `${JSON.stringify(report, null, 2)}\n`
  )
  process.stdout.write(
    `${JSON.stringify({ runtime: process.versions.node, reports, orderingCases: matrix.length, observerCases: observers.length, unhandledRejections: unhandled.length }, null, 2)}\n`
  )
}
main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
