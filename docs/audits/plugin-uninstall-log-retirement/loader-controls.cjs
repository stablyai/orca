const assert = require('node:assert/strict')
const { writeFileSync, existsSync } = require('node:fs')
const path = require('node:path')
const { parsePatch, applyPatch, reversePatch } = require('diff')
const { loadSources, readText, sha256 } = require('./sources.cjs')
const root = path.resolve(__dirname, '../../..')
const versions = JSON.parse(readText(path.join(__dirname, 'source-versions.json')))
const contexts = parsePatch(readText(path.join(__dirname, 'dependency-context.patch')))
const mainSources = new Map()
for (const patch of contexts) {
  const name = patch.newFileName.slice(2)
  const current = readText(path.join(root, name))
  const original =
    sha256(current) === versions.sources[name].main
      ? current
      : applyPatch(current, reversePatch(patch))
  assert.notEqual(original, false)
  assert.equal(sha256(original), versions.sources[name].main)
  mainSources.set(path.join(root, name), original)
}
const observations = []
for (const variant of ['before', 'fixed']) {
  const normal = loadSources({ variant })
  const crlf = loadSources({ variant, read: (name) => readText(name).replaceAll('\n', '\r\n') })
  const published = loadSources({
    variant,
    read: (name) => mainSources.get(name) ?? readText(name),
    exists: existsSync
  })
  assert.deepEqual(crlf.hashes, normal.hashes)
  assert.deepEqual(published.hashes, normal.hashes)
  observations.push({
    variant,
    repositoryPaths: normal.sources.size,
    crlfMatches: true,
    simulatedMainPublicationMatches: true,
    sourceHash: sha256(JSON.stringify(normal.hashes))
  })
}
const target = path.join(root, 'src/main/plugins/plugin-log-buffer.ts')
assert.throws(
  () =>
    loadSources({
      read: (name) => (name === target ? `${readText(name)}\n// drift\n` : readText(name))
    }),
  /Source drift/
)
writeFileSync(
  process.env.ORCA_PLUGIN_LOG_LOADER_OUTPUT ?? path.join(__dirname, 'loader-results.json'),
  `${JSON.stringify({ observations, currentDependencyContextPaths: versions.currentDependencyContextPaths, driftRejected: true }, null, 2)}\n`
)
