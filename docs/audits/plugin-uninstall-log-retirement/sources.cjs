const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { parsePatch, applyPatch, reversePatch } = require('diff')
const root = path.resolve(__dirname, '../../..')
const canonicalLf = (text) => text.replaceAll('\r\n', '\n')
const readText = (name) => canonicalLf(readFileSync(name, 'utf8'))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
function loadSources({
  variant = process.env.ORCA_PLUGIN_LOG_VARIANT ?? 'fixed',
  read = readText,
  exists = existsSync
} = {}) {
  assert.ok(['before', 'fixed'].includes(variant))
  const versions = JSON.parse(read(path.join(__dirname, 'source-versions.json')))
  const patches = (name) =>
    new Map(
      parsePatch(canonicalLf(read(path.join(__dirname, name))))
        .filter((patch) => patch.newFileName)
        .map((patch) => [patch.newFileName.slice(2), patch])
    )
  const fixes = patches('fix.patch')
  const contexts = patches('dependency-context.patch')
  const sources = new Map()
  const hashes = {}
  for (const [relative, entry] of Object.entries(versions.sources)) {
    const filename = path.join(root, relative)
    let source = exists(filename) ? canonicalLf(read(filename)) : null
    let hash = source === null ? null : sha256(source)
    if (hash !== entry.fixed && hash === entry.main && contexts.has(relative)) {
      source = applyPatch(source ?? '', contexts.get(relative))
      assert.notEqual(source, false, `Dependency context failed: ${relative}`)
      hash = sha256(source)
    }
    assert.equal(hash, entry.fixed, `Source drift: ${relative}`)
    if (variant === 'before' && fixes.has(relative)) {
      source = applyPatch(source, reversePatch(fixes.get(relative)))
      assert.notEqual(source, false, `Reverse fix failed: ${relative}`)
    }
    if (variant === 'before' && entry.before === null) {
      assert.equal(source, '')
      continue
    }
    assert.equal(sha256(source), variant === 'before' ? entry.before : entry.fixed)
    sources.set(path.join(root, relative), source)
    hashes[relative] = sha256(source)
  }
  for (const [relative, expected] of Object.entries(versions.dependencies)) {
    assert.equal(
      sha256(canonicalLf(read(path.join(root, relative)))),
      expected,
      `Dependency drift: ${relative}`
    )
  }
  return { root, sources, hashes, variant, versions }
}
module.exports = { loadSources, canonicalLf, readText, sha256 }
