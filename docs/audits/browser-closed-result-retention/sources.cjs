const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { resolve } = require('node:path')
const { applyPatch, parsePatch, reversePatch } = require('diff')

const canonicalLf = (text) => text.replace(/\r\n/g, '\n')
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function loadSources({ readText = (filename) => readFileSync(filename, 'utf8') } = {}) {
  const root = resolve(__dirname, '../../..')
  const expected = JSON.parse(readFileSync(resolve(__dirname, 'source-versions.json'), 'utf8'))
  const patches = parsePatch(canonicalLf(readText(resolve(__dirname, 'fix.patch'))))
  const before = new Map()
  const after = new Map()
  const hashes = {}
  assert.equal(patches.length, 2)
  for (const patch of patches) {
    const path = patch.newFileName.replace(/^b\//, '')
    assert.ok(Object.hasOwn(expected.baselineHashes, path), `Unexpected patch path: ${path}`)
    const absolute = resolve(root, path)
    const current = canonicalLf(readText(absolute))
    const baseline = applyPatch(current, reversePatch(patch))
    assert.notEqual(baseline, false, `Patch no longer reverses: ${path}`)
    assert.equal(sha256(current), expected.fixedHashes[path], `Fixed source drift: ${path}`)
    assert.equal(sha256(baseline), expected.baselineHashes[path], `Baseline source drift: ${path}`)
    before.set(absolute, baseline)
    after.set(absolute, current)
    hashes[path] = { before: sha256(baseline), after: sha256(current) }
  }
  for (const source of expected.sources) {
    if (Object.hasOwn(hashes, source.path)) {
      continue
    }
    const text = canonicalLf(readText(resolve(root, source.path)))
    assert.equal(sha256(text), source.workingSha256, `Caller source drift: ${source.path}`)
    hashes[source.path] = { before: sha256(text), after: sha256(text) }
  }
  return { root, before, after, hashes }
}

module.exports = { loadSources }
