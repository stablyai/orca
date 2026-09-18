const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parsePatch, reversePatch, applyPatch } = require('diff')

const root = path.resolve(__dirname, '../../..')
const relativePath = 'src/main/gitlab/gitlab-known-host-probe.ts'
const sourcePath = path.join(root, relativePath)
const fixed = fs.readFileSync(sourcePath, 'utf8')
const patches = parsePatch(fs.readFileSync(path.join(__dirname, 'fix.patch'), 'utf8'))
assert.equal(patches.length, 1)
assert.equal(patches[0].newFileName, `b/${relativePath}`)
const baseline = applyPatch(fixed, reversePatch(patches[0]))
assert.notEqual(baseline, false, 'Current source must reverse exactly to the original cache')
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex')
assert.equal(hash(baseline), require('./original-source-hashes.json')[relativePath])
const sourceHashes = {
  [relativePath]: { baseline: hash(baseline), fixed: hash(fixed) },
  ...Object.fromEntries(
    [
      'src/main/git/coalesced-probe.ts',
      'src/main/git/remote-ref-probe-cache.ts',
      'src/main/gitlab/project-ref-parser.ts',
      'src/main/gitlab/gitlab-known-host-retirement.test.ts'
    ].map((file) => [file, hash(fs.readFileSync(path.join(root, file)))])
  )
}

module.exports = { root, sourcePath, baseline, fixed, sourceHashes, hash }
