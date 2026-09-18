const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const crypto = require('node:crypto')
module.exports = function installCandidate(packageName = '@xterm/headless', applyGuard = true) {
  const filename = require.resolve(packageName)
  const source = fs.readFileSync(filename, 'utf8')
  const anchor =
    /for\(let (\w+)=(\w+)\.newLines\.length-1;\1>=0(?:&&\w+>=0)?;\1--\)this\.lines\.set\((\w+)--,\2\.newLines\[\1\]\)/g
  const matches = [...source.matchAll(anchor)]
  assert.equal(matches.length, 1, 'Unique actual installed insertion-loop anchor')
  const [before, sourceIndex, insertion, destination] = matches[0]
  const after = `for(let ${sourceIndex}=${insertion}.newLines.length-1;${sourceIndex}>=0&&${destination}>=0;${sourceIndex}--)this.lines.set(${destination}--,${insertion}.newLines[${sourceIndex}])`
  const baselineLoop = `for(let ${sourceIndex}=${insertion}.newLines.length-1;${sourceIndex}>=0;${sourceIndex}--)this.lines.set(${destination}--,${insertion}.newLines[${sourceIndex}])`
  assert(before === baselineLoop || before === after, 'Only the known destination guard may differ')
  const baseline = source.replace(before, baselineLoop)
  const candidate = source.replace(before, after)
  const selected = applyGuard ? candidate : baseline
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(require('node:path').dirname(filename))
  require.cache[filename] = loaded
  loaded._compile(selected, filename)
  return {
    appliedGuard: applyGuard,
    baselineSha256: crypto.createHash('sha256').update(baseline).digest('hex'),
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    candidateSha256: crypto.createHash('sha256').update(candidate).digest('hex'),
    before,
    after
  }
}
