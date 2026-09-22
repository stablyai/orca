const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { canonicalLf, load, loadSources } = require('./sources.cjs')
const run = require('./scenario.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')

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
    process.stderr.write('proof deadline\n')
    process.exit(2)
  }, 15_000)
  const crlfLoaderControl = checkCrlfLoader()
  const reports = {}
  const versions = {}
  for (const [mode, fixed] of [
    ['before', false],
    ['after', true]
  ]) {
    const loaded = await load(fixed)
    reports[mode] = await run(loaded.create, fixed)
    versions[mode] = {
      sourceHashes: loaded.hashes,
      bundleSha256: loaded.bundleSha256,
      dependencies: loaded.dependencies
    }
  }
  clearTimeout(timer)
  const emitter = require.resolve('node-pty/lib/eventEmitter2')
  const report = {
    runtime: process.versions,
    sourceHashLineEndings: 'canonical LF',
    crlfLoaderControl,
    scope:
      'Actual wrapper, foreground tracker and pre-listener queue, with the installed node-pty event emitter and an inert native process. No native PTY, process scan, OS signal or window. Small object counts, no payload amplification.',
    nodePty: {
      version: require('node-pty/package.json').version,
      eventEmitterSha256: createHash('sha256')
        .update(canonicalLf(readFileSync(emitter, 'utf8')))
        .digest('hex')
    },
    reports,
    versions
  }
  const name = process.versions.electron ? 'electron-results.json' : 'node-results.json'
  writeFileSync(path.join(__dirname, name), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ runtime: process.versions.node, reports }, null, 2)}\n`)
}
main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
