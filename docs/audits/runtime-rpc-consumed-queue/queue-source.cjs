const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')
const versions = require('./source-versions.json')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const root = path.resolve(__dirname, '../../..')
const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const fixedSource = readText(path.join(root, versions.sourcePath))
assert.equal(sha(fixedSource), versions.fixedSha256, 'Product source changed; review proof hashes')
const patches = parsePatch(readText(path.join(__dirname, 'fix.patch')))
assert.equal(patches.length, 1)
const baselineSource = applyPatch(fixedSource, reversePatch(patches[0]))
assert.notEqual(baselineSource, false)
assert.equal(sha(baselineSource), versions.baselineSha256, 'Baseline reconstruction changed')

function load(candidate) {
  const build = esbuild.buildSync({
    stdin: {
      contents: candidate ? fixedSource : baselineSource,
      resolveDir: path.join(root, 'src/shared'),
      sourcefile: versions.sourcePath,
      loader: 'ts'
    },
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
    write: false
  })
  const filename = path.join(__dirname, 'bundled-queue.cjs')
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(__dirname)
  loaded._compile(build.outputFiles[0].text, filename)
  return loaded.exports.RuntimeRpcCallQueuePool
}

async function collect() {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    global.gc()
  }
}

module.exports = { load, collect, sha, versions, baselineSource }
