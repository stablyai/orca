const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { applyPatch, parsePatch, reversePatch } = require('diff')
const root = path.resolve(__dirname, '../../..')
const patches = parsePatch(fs.readFileSync(path.join(__dirname, 'fix.patch'), 'utf8'))
const expected = require('./original-source-hashes.json')
const originals = new Map()
const sourceHashes = {}
for (const patch of patches) {
  const relative = patch.newFileName.replace(/^b\//, '')
  const file = path.join(root, relative)
  const current = fs.readFileSync(file, 'utf8')
  const original = applyPatch(current, reversePatch(patch))
  assert.notEqual(original, false, `Source no longer reverses: ${relative}`)
  const hash = (source) => crypto.createHash('sha256').update(source).digest('hex')
  if (patch.oldFileName !== '/dev/null') {
    assert.equal(hash(original), expected[relative], `Original source drift: ${relative}`)
    originals.set(file, original)
  } else {
    assert.equal(original, '')
  }
  sourceHashes[relative] = { baseline: hash(original), fixed: hash(current) }
}
function originalSourcePlugin() {
  return {
    name: 'speech-budget-original-source',
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, ({ path: file }) => {
        if (originals.has(file)) {
          return { contents: originals.get(file), loader: 'ts' }
        }
      })
    }
  }
}
module.exports = { root, sourceHashes, originalSourcePlugin }
