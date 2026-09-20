const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { applyPatch, parsePatch, reversePatch } = require('diff')

module.exports = function loadSources() {
  const root = resolve(__dirname, '../../..')
  const expected = JSON.parse(readFileSync(resolve(__dirname, 'source-versions.json'), 'utf8'))
  const parsed = parsePatch(readFileSync(resolve(__dirname, 'fix.patch'), 'utf8'))
  const before = new Map()
  const after = new Map()
  const hashes = {}
  assert.equal(parsed.length, 2)
  for (const patch of parsed) {
    const path = patch.newFileName.replace(/^b\//, '')
    assert.ok(Object.hasOwn(expected.baselineHashes, path), `Unexpected patch path: ${path}`)
    const absolute = resolve(root, path)
    const current = readFileSync(absolute, 'utf8')
    const baseline = applyPatch(current, reversePatch(patch))
    assert.notEqual(baseline, false, `Source changed; review fix.patch: ${path}`)
    const hash = (source) => createHash('sha256').update(source).digest('hex')
    assert.equal(hash(baseline), expected.baselineHashes[path], `Baseline drift: ${path}`)
    before.set(absolute, baseline)
    after.set(absolute, current)
    hashes[path] = { before: hash(baseline), after: hash(current) }
  }
  return { root, before, after, hashes }
}
