const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { applyPatch, parsePatch, reversePatch } = require('diff')

module.exports = function loadSources() {
  const root = path.resolve(__dirname, '../../..')
  const transform = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'candidate-transform.json'), 'utf8')
  )
  const sourcePath = path.join(root, transform.path)
  const windowCandidate = fs.readFileSync(sourcePath, 'utf8')
  const patch = parsePatch(fs.readFileSync(path.join(__dirname, 'fix.patch'), 'utf8'))
  assert.equal(patch.length, 1)
  const baseline = applyPatch(windowCandidate, reversePatch(patch[0]))
  assert.notEqual(baseline, false, 'Source changed; review fix.patch')
  assert.equal(
    createHash('sha256').update(baseline).digest('hex'),
    transform.sha256,
    'Baseline drift'
  )
  let candidate = baseline
  for (const change of transform.changes) {
    assert.equal(candidate.split(change.before).length, 2)
    candidate = candidate.replace(change.before, change.after)
  }
  return {
    root,
    sourcePath,
    sourceRelativePath: transform.path,
    baseline,
    candidate,
    windowCandidate
  }
}
