const assert = require('node:assert/strict')
const { existsSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { loadSources, readText, sha256, versions } = require('./sources.cjs')

const observations = []
const published = loadSources({ graph: 'main', variant: 'fixed' })
const virtualRead = (filename) => published.sources.get(filename) ?? readText(filename)
const virtualExists = (filename) => {
  const relative = path.relative(published.root, filename).split(path.sep).join('/')
  return Object.hasOwn(versions.sources, relative)
    ? published.sources.has(filename)
    : existsSync(filename)
}
for (const graph of ['worktree', 'main']) {
  for (const variant of ['before', 'fixed']) {
    const normal = loadSources({ graph, variant })
    const crlf = loadSources({
      graph,
      variant,
      read: (filename) => readText(filename).replaceAll('\n', '\r\n')
    })
    const fromPublication = loadSources({
      graph,
      variant,
      read: virtualRead,
      exists: virtualExists
    })
    assert.deepEqual(crlf.hashes, normal.hashes)
    assert.deepEqual(fromPublication.hashes, normal.hashes)
    observations.push({
      graph,
      variant,
      sources: normal.sources.size,
      canonicalLfMatches: true,
      simulatedMainCheckoutMatches: true,
      graphSha256: sha256(JSON.stringify(normal.hashes))
    })
  }
}
const setup = path.join(published.root, 'src/renderer/src/lib/monaco-setup.ts')
assert.ok(published.sources.get(setup).includes('registerShellMarkdownAliases(monaco)'))
assert.throws(
  () =>
    loadSources({
      read: (filename) =>
        filename === setup ? `${readText(filename)}\n// drift\n` : readText(filename)
    }),
  /Fixed source drift/
)
writeFileSync(
  process.env.ORCA_CLOSED_MODEL_LOADER_OUTPUT ?? path.join(__dirname, 'loader-results.json'),
  `${JSON.stringify({ observations, mainMarkdownAliasesPreserved: true, driftRejected: true }, null, 2)}\n`
)
