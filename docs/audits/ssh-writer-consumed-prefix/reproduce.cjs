const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { load, loadSources, canonicalLf } = require('./sources.cjs')
const { scenario, realWritableScenario, inFlightOwnership } = require('./scenario.cjs')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
function checkCrlfLoader() {
  const normal = loadSources()
  let syntheticCrlfReads = 0
  const crlf = loadSources({
    readText(file) {
      syntheticCrlfReads++
      return canonicalLf(readFileSync(file, 'utf8')).replace(/\n/g, '\r\n')
    }
  })
  assert.equal(syntheticCrlfReads, 2)
  assert.deepEqual(crlf.before, normal.before)
  assert.deepEqual(crlf.after, normal.after)
  assert.deepEqual(crlf.hashes, normal.hashes)
  return { syntheticCrlfReads, identicalSourcesAndHashes: true }
}
async function main() {
  const timer = setTimeout(() => {
    process.stderr.write('deadline\n')
    process.exit(2)
  }, 20_000)
  const output = {
    runtime: process.versions,
    sourceHashLineEndings: 'canonical LF',
    crlfLoaderControl: checkCrlfLoader(),
    cases: [],
    versions: []
  }
  for (const fixed of [false, true]) {
    const api = await load(fixed)
    output.versions.push({ fixed, ...api.versions })
    for (const lane of ['ordinary', 'control']) {
      for (const release of ['drain', 'dispose']) {
        output.cases.push(await scenario(api, fixed, release, lane))
      }
    }
    output.cases.push(await realWritableScenario(api, fixed))
    output.cases.push(await inFlightOwnership(api, fixed))
  }
  clearTimeout(timer)
  const defaultName = process.versions.electron ? 'electron-results.json' : 'node-results.json'
  const destination = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, defaultName)
  writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(output.cases, null, 2)}\n`)
}
main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
