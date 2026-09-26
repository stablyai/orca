const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { load, loadSources, read, sha } = require('./sources.cjs')
const { exercise } = require('./scenario.cjs')

async function run({ readSource = read, output, sourceLabel = 'working-tree' } = {}) {
  assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
  const phases = {}
  for (const phase of ['before', 'fixed']) {
    const loaded = await load(phase, readSource)
    phases[phase] = { ...(await exercise(loaded.api, phase)), provenance: loaded.provenance }
  }
  let crlfReads = 0
  const crlf = loadSources((file) => {
    crlfReads += 1
    return readSource(file).replaceAll('\n', '\r\n')
  })
  assert.deepEqual(crlf, loadSources(readSource))
  assert.equal(crlfReads, 2)
  const artifacts = [
    'sources.cjs',
    'scenario.cjs',
    'reproduce.cjs',
    'before.config.mjs',
    'source-versions.json',
    'fix.patch'
  ]
  const result = {
    scope:
      'Actual degraded provider/recovery/resolvers, adapter inventory, identity publication and direct attach; finite inert authenticated transport replies, no native PTY or network',
    runtime: process.versions,
    sourceLabel,
    crlfReads,
    artifactHashes: Object.fromEntries(
      artifacts.map((file) => [file, sha(read(path.join(__dirname, file)))])
    ),
    phases
  }
  const filename =
    output ??
    path.join(__dirname, process.versions.electron ? 'electron-results.json' : 'node-results.json')
  fs.writeFileSync(filename, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    JSON.stringify({
      output: filename,
      before: phases.before.afterLegacyExit,
      fixed: phases.fixed.afterLegacyExit,
      sourceLabel
    })
  )
  return result
}

module.exports = { run }
if (require.main === module) {
  run({ output: process.argv[2] }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
